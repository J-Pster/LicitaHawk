import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../src/common/dynamodb-client";
import { ufModalidadeKey } from "../src/tenders/uf-modalidade-key";

/**
 * Backfill unico do atributo derivado `uf_modalidade` (GSI4), para os tenders gravados ANTES da
 * versao que passou a escrever esse campo na ingestao (pncp-client.ts::normalizeTender).
 *
 * Por que e' obrigatorio: uma GSI do DynamoDB so indexa itens que POSSUEM os atributos-chave dela.
 * Criar a GSI4 numa tabela que ja tem dados nao popula nada retroativamente -- sem este backfill, a
 * busca combinada uf+modalidade responderia 200 com lista vazia para todo o acervo antigo, que e' o
 * pior modo de falha possivel (indistinguivel de "nao existe licitacao com esse recorte").
 *
 * Scan e' proibido em codigo de API (regra do projeto), e continua sendo: aqui e' um script de
 * migracao de execucao unica, fora do caminho de request, com o custo pago uma vez.
 *
 * Idempotente por construcao: `attribute_not_exists(uf_modalidade)` como ConditionExpression, entao
 * reexecutar so pula o que ja foi feito. Pode ser interrompido e retomado a qualquer momento.
 *
 *   DYNAMODB_ENDPOINT=http://localhost:8000 npm run backfill-uf-modalidade
 */

const TENDERS_TABLE = "Tenders";
const WRITE_CONCURRENCY = 25;

interface ScannedItem {
  pncp_control_number: string;
  uf?: string;
  modalidade?: string;
  uf_modalidade?: string;
}

async function backfillItem(item: ScannedItem): Promise<"updated" | "skipped"> {
  if (item.uf_modalidade) return "skipped";

  await ddbDocClient.send(
    new UpdateCommand({
      TableName: TENDERS_TABLE,
      Key: { pncp_control_number: item.pncp_control_number },
      UpdateExpression: "SET uf_modalidade = :v",
      ConditionExpression: "attribute_not_exists(uf_modalidade)",
      ExpressionAttributeValues: { ":v": ufModalidadeKey(item.uf ?? "", item.modalidade ?? "") },
    }),
  );
  return "updated";
}

async function main(): Promise<void> {
  let startKey: Record<string, unknown> | undefined;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  do {
    const res = await ddbDocClient.send(
      new ScanCommand({
        TableName: TENDERS_TABLE,
        ProjectionExpression: "pncp_control_number, uf, modalidade, uf_modalidade",
        ExclusiveStartKey: startKey,
      }),
    );

    const items = (res.Items ?? []) as ScannedItem[];
    scanned += items.length;

    for (let i = 0; i < items.length; i += WRITE_CONCURRENCY) {
      const chunk = items.slice(i, i + WRITE_CONCURRENCY);
      const results = await Promise.allSettled(chunk.map(backfillItem));
      for (const result of results) {
        if (result.status === "rejected") {
          // ConditionalCheckFailed = outro processo (ou uma execucao anterior) ja preencheu o item
          // entre o Scan e o Update -- resultado final identico, nao e' falha.
          const name = (result.reason as { name?: string })?.name;
          if (name === "ConditionalCheckFailedException") skipped += 1;
          else {
            failed += 1;
            console.error("[backfill] falha ao atualizar item", result.reason);
          }
        } else if (result.value === "updated") updated += 1;
        else skipped += 1;
      }
    }

    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    console.log(`[backfill] lidos=${scanned} atualizados=${updated} ja_ok=${skipped} falhas=${failed}`);
  } while (startKey);

  console.log(`[backfill] FIM -- lidos=${scanned} atualizados=${updated} ja_ok=${skipped} falhas=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

void main();
