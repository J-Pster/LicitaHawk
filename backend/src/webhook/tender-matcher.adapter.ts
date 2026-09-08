import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { TenderIngestedPort } from "../common/ports/tender-ingested-port";
import { AlertQueuePort, TenderMatchedPayload } from "../common/ports/alert-queue-port";
import { matchesKeyword } from "../common/keyword-match";
import { incrementDailyUsage } from "../common/usage-daily.repository";
import { Tender } from "../tenders/tender.types";
import { parseSavedFilters, SavedFilter } from "./filter.types";
import { toDeliveryTarget } from "./alert-target";

const SAVED_FILTERS_TABLE = "SavedFilters";
const GSI_NAME = "GSI-uf-modalidade";

/**
 * Consulta o subconjunto candidato via GSI uf+modalidade (nunca Scan na tabela toda de filtros).
 */
async function findCandidateFilters(uf: string, modalidade: string): Promise<SavedFilter[]> {
  const res = await ddbDocClient.send(
    new QueryCommand({
      TableName: SAVED_FILTERS_TABLE,
      IndexName: GSI_NAME,
      KeyConditionExpression: "uf = :uf AND modalidade = :modalidade",
      ExpressionAttributeValues: { ":uf": uf, ":modalidade": modalidade },
    }),
  );
  return parseSavedFilters((res.Items ?? []) as Record<string, unknown>[]);
}

export function buildWebhookPayload(tender: Tender, filter: SavedFilter): TenderMatchedPayload {
  return {
    event: "tender.matched",
    filter_id: filter.filter_id,
    tender: {
      pncp_control_number: tender.pncp_control_number,
      org_cnpj: tender.org_cnpj,
      org_name: tender.org_name,
      uf: tender.uf,
      modalidade: tender.modalidade,
      objeto: tender.objeto,
      valor_estimado: tender.valor_estimado,
      link_pncp: tender.link_pncp,
    },
  };
}

export class LocalTenderMatcherAdapter implements TenderIngestedPort {
  constructor(private readonly alertQueue: AlertQueuePort) {}

  async emit(tender: Tender): Promise<void> {
    const candidates = await findCandidateFilters(tender.uf, tender.modalidade);
    for (const filter of candidates) {
      if (!filter.active) continue;
      if (filter.keyword && !matchesKeyword(tender, filter.keyword)) continue;

      // Conta 1 tentativa real de disparo por filtro casado, aqui na origem (nao dentro do
      // enqueue/dispatcher em si) -- se o processo morrer e a entrega for recuperada no proximo
      // boot (webhook-queue-recovery.ts reenfileira o MESMO job), isso NAO deve contar de novo,
      // ja que e' o mesmo disparo sendo retomado, nao um novo. O canal decide o balde de uso: um
      // alerta por email nao pode aparecer como consumo de webhook no relatorio do cliente.
      // incrementDailyUsage nunca lanca (telemetria), fire-and-forget mesmo padrao do enqueue.
      incrementDailyUsage(filter.customer_id, filter.channel).catch(() => {});

      // Fire-and-forget (nao await): a entrega (in-memory-alert-queue.adapter.ts) faz ate 3
      // tentativas com backoff, ~17s no pior caso. Achado real da revisao de qualidade: await
      // aqui travava o loop de ingestao inteiro por filtro popular com URL lenta/fora do ar,
      // atrasando o checkpoint de TODOS os clientes. O .catch evita unhandled rejection --
      // falha real ja fica registrada via circuit-breaker/delivery-log dentro do proprio enqueue.
      this.alertQueue
        .enqueue({
          filter_id: filter.filter_id,
          customer_id: filter.customer_id,
          target: toDeliveryTarget(filter),
          payload: buildWebhookPayload(tender, filter),
          attempt: 1,
          idempotencyKey: `${tender.pncp_control_number}:${filter.filter_id}`,
        })
        .catch((err) => console.error(`[tender-matcher] falha ao enfileirar alerta do filtro ${filter.filter_id}`, err));
    }
  }
}
