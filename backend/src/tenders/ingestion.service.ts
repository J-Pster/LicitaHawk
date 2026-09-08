import { BatchWriteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { TenderIngestedPort } from "../common/ports/tender-ingested-port";
import { fetchContratacoesAtualizacaoPage, normalizeTender, MODALIDADE_CODES } from "./pncp-client";
import { Tender } from "./tender.types";
import { checkRateLimitAnomaly } from "./rate-limit-tracking";

const CHECKPOINT_TABLE = "Checkpoint";
const TENDERS_TABLE = "Tenders";
const JOB_NAME = "ingestion";

// BatchWriteItem aceita no maximo 25 operacoes por chamada (limite do DynamoDB).
const BATCH_WRITE_SIZE = 25;
// O DynamoDB pode devolver itens NAO processados por throttling sem que isso seja erro -- a
// obrigacao de reenviar e' do cliente. Depois destas tentativas com backoff exponencial, desistimos
// e deixamos a excecao subir: quem chama trata como "modalidade falhou" e NAO avanca o checkpoint,
// entao a janela inteira e' reprocessada na proxima execucao (upsert por PK, reprocessar e' barato).
const BATCH_WRITE_MAX_ATTEMPTS = 5;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Grava os tenders em lotes de 25 (upsert por `pncp_control_number`), em vez de um PutItem por item.
 * A ingestao escreve milhares de itens por janela; uma ida ao DynamoDB por licitacao dominava o
 * tempo do job inteiro. Mesma semantica de antes (upsert idempotente, nenhum item duplicado),
 * ~25x menos round-trips.
 *
 * Devolve os itens EFETIVAMENTE gravados -- o chamador so emite o evento de "tender ingerido"
 * (que dispara os webhooks) para esses, nunca para um item que ficou pelo caminho.
 */
async function putTendersBatched(tenders: Tender[]): Promise<Tender[]> {
  const persisted: Tender[] = [];

  for (let start = 0; start < tenders.length; start += BATCH_WRITE_SIZE) {
    const chunk = tenders.slice(start, start + BATCH_WRITE_SIZE);
    let pending: Record<string, unknown>[] = chunk.map((tender) => ({ PutRequest: { Item: tender } }));

    for (let attempt = 0; attempt < BATCH_WRITE_MAX_ATTEMPTS && pending.length > 0; attempt++) {
      if (attempt > 0) await delay(2 ** attempt * 100);
      const res = await ddbDocClient.send(
        new BatchWriteCommand({ RequestItems: { [TENDERS_TABLE]: pending as never } }),
      );
      pending = (res.UnprocessedItems?.[TENDERS_TABLE] ?? []) as Record<string, unknown>[];
    }

    if (pending.length > 0) {
      throw new Error(
        `[ingestion] ${pending.length} item(ns) nao gravados apos ${BATCH_WRITE_MAX_ATTEMPTS} tentativas de BatchWrite`,
      );
    }
    persisted.push(...chunk);
  }

  return persisted;
}

export function formatYYYYMMDD(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

const CHECKPOINT_DATE_FORMAT = /^\d{8}$/;

function yesterdayFallback(): string {
  return formatYYYYMMDD(new Date(Date.now() - 24 * 3600 * 1000));
}

async function getCheckpoint(): Promise<string> {
  const res = await ddbDocClient.send(
    new GetCommand({ TableName: CHECKPOINT_TABLE, Key: { job_name: JOB_NAME } }),
  );
  const lastProcessedDate = res.Item?.last_processed_date as string | undefined;
  if (lastProcessedDate === undefined) {
    // primeira execucao (sem checkpoint salvo): comeca de ontem, evita full scan historico acidental.
    return yesterdayFallback();
  }
  if (!CHECKPOINT_DATE_FORMAT.test(lastProcessedDate)) {
    // Achado real da Rodada 6: sem essa validacao, um checkpoint corrompido (ex.: editado a mao via
    // dynamodb-admin, que o proprio docker-compose.yml deste projeto expoe na porta 8001) travava a
    // ingestao incremental pra sempre -- a mesma data invalida seria reenviada ao PNCP em toda
    // execucao futura, sem nenhum jeito de autocorrecao. Trata igual a "sem checkpoint": comeca de
    // ontem de novo.
    console.error(
      `[ingestion] checkpoint corrompido ("${lastProcessedDate}", esperado YYYYMMDD) -- descartando e recomecando de ontem`,
    );
    return yesterdayFallback();
  }
  return lastProcessedDate;
}

async function saveCheckpoint(date: string): Promise<void> {
  await ddbDocClient.send(
    new PutCommand({
      TableName: CHECKPOINT_TABLE,
      Item: { job_name: JOB_NAME, last_processed_date: date, updated_at: new Date().toISOString() },
    }),
  );
}

export interface IngestResult {
  fetched: number;
  written: number;
  failedModalidades: number[];
}

/**
 * Busca e grava todas as contratacoes atualizadas na janela [dataInicial, dataFinal] (YYYYMMDD),
 * para todas as modalidades validas. Reaproveitado pela ingestao incremental e pela reconciliacao.
 * Upsert por pncp_control_number (PK) -- dedupe e automatico: nunca existe item duplicado pra mesma chave.
 */
export async function ingestWindow(
  dataInicial: string,
  dataFinal: string,
  port: TenderIngestedPort,
): Promise<IngestResult> {
  let fetched = 0;
  let written = 0;
  const failedModalidades: number[] = [];

  for (const codigoModalidade of MODALIDADE_CODES) {
    try {
      let pagina = 1;
      for (;;) {
        const page = await fetchContratacoesAtualizacaoPage(dataInicial, dataFinal, codigoModalidade, pagina);
        if (!page || !page.data || page.data.length === 0) {
          break;
        }
        fetched += page.data.length;

        const tenders: Tender[] = [];
        const seenInPage = new Set<string>();
        for (const raw of page.data) {
          const tender = normalizeTender(raw);
          if (!tender.pncp_control_number) {
            console.warn("[ingestion] item sem numeroControlePNCP, ignorado", raw);
            continue;
          }
          // BatchWrite rejeita a requisicao INTEIRA se dois itens dela tiverem a mesma chave. O
          // dedupe por pagina e' barato e garante que uma repeticao do PNCP nunca derrube o lote.
          if (seenInPage.has(tender.pncp_control_number)) continue;
          seenInPage.add(tender.pncp_control_number);
          tenders.push(tender);
        }

        const persisted = await putTendersBatched(tenders);
        written += persisted.length;
        for (const tender of persisted) {
          await port.emit(tender);
        }

        if (pagina >= page.totalPaginas) {
          break;
        }
        pagina += 1;
      }
    } catch (err) {
      // Uma modalidade instavel (ex.: 429 persistente) nao pode derrubar a janela inteira -- as
      // demais modalidades ainda precisam ser processadas. A modalidade fica registrada em
      // failedModalidades pra runIncrementalIngestion decidir se pode avancar o checkpoint (nao
      // pode, se alguma falhou -- ver correcao abaixo, achado real da revisao funcional: o
      // checkpoint avancava incondicionalmente antes, causando risco de perda silenciosa e
      // permanente de dado).
      console.error(`[ingestion] falha na modalidade ${codigoModalidade}, pulando`, err);
      failedModalidades.push(codigoModalidade);
    }
  }

  // roda no fim de toda janela (incremental E reconciliacao) -- checagem de anomalia de rate
  // limit e' so log de observabilidade, nunca lanca (ver rate-limit-tracking.ts).
  await checkRateLimitAnomaly();

  return { fetched, written, failedModalidades };
}

/**
 * Job de ingestao incremental (Fase 2.3): busca desde o ultimo checkpoint ate hoje,
 * grava o novo checkpoint SOMENTE se todas as modalidades processaram com sucesso. Se alguma
 * falhou (ex.: rate limit do PNCP), o checkpoint fica intocado -- a proxima execucao (15 min
 * depois) reprocessa a MESMA janela inteira (upsert por pncp_control_number e' idempotente, entao
 * reprocessar modalidade que ja deu certo so re-escreve o mesmo dado, sem duplicar nem custar
 * caro). Prefere retrabalho a perda de dado.
 */
export async function runIncrementalIngestion(port: TenderIngestedPort): Promise<IngestResult> {
  const dataInicial = await getCheckpoint();
  const dataFinal = formatYYYYMMDD(new Date());

  const result = await ingestWindow(dataInicial, dataFinal, port);
  if (result.failedModalidades.length === 0) {
    await saveCheckpoint(dataFinal);
  } else {
    console.warn(
      `[ingestion] checkpoint NAO avancado (modalidades com falha: ${result.failedModalidades.join(",")}) -- proxima execucao reprocessa a mesma janela`,
    );
  }

  return result;
}
