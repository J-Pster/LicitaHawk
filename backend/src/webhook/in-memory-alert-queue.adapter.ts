import { AlertDeliveryJob, AlertQueuePort } from "../common/ports/alert-queue-port";
import { dispatchWebhook, DispatchResult } from "./webhook-dispatcher";
import { dispatchAlertEmail } from "./email-alert-dispatcher";
import { SsrfBlockedError } from "./ssrf-guard";
import { recordFailure, recordSuccess } from "./circuit-breaker";
import { writeDeliveryLog } from "./delivery-log";
import { persistPendingDelivery, removePendingDelivery } from "./webhook-delivery-queue.repository";
import { opsAlert } from "../common/ops-alert";

// Fila em memoria (Fase 4.2), agora com apoio durvel em DynamoDB (Rodada 4, item #5 do PLAN.md):
// enqueue() grava a intencao de entrega ANTES de tentar despachar e so remove o registro ao
// final (sucesso ou esgotamento de tentativas). Se o processo morrer no meio das tentativas, o
// registro sobrevive e e' recuperado no proximo boot (ver webhook-queue-recovery.ts). O
// processamento em si (retry/backoff/circuit-breaker) continua no mesmo processo -- producao
// troca por SQS real atras da mesma interface AlertQueuePort (ver ADR no PLAN.md); a
// persistencia aqui cobre o gap real de hoje (perda em restart), nao substitui SQS.
//
// A fila serve os DOIS canais de alerta (webhook e email) de proposito: retry, backoff, circuit
// breaker e log de entrega sao politica de entrega, nao detalhe de transporte. Duplicar isso por
// canal seria garantir que os dois divergem na primeira correcao de bug.
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1500, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptDelivery(job: AlertDeliveryJob): Promise<DispatchResult & { permanent?: boolean }> {
  try {
    if (job.target.channel === "email") {
      return await dispatchAlertEmail(job.customer_id, job.payload);
    }
    return await dispatchWebhook(job.target.url, job.target.secret, job.payload, job.idempotencyKey);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      // URL insegura: nao adianta retry, o resultado nao muda. Nunca logar o secret aqui.
      console.error(`[alert-queue] disparo bloqueado por SSRF | filter_id=${job.filter_id} | ${err.message}`);
      return { success: false, error: err.message, permanent: true };
    }
    return { success: false, error: (err as Error).message };
  }
}

export class InMemoryAlertQueueAdapter implements AlertQueuePort {
  async enqueue(job: AlertDeliveryJob): Promise<void> {
    // Persistencia best-effort: se o DynamoDB estiver fora do ar aqui, a entrega ainda acontece
    // (nao bloqueia o produto por causa de uma camada de durabilidade), so perde a garantia de
    // sobreviver a um restart nesse caso especifico -- registrado via ops-alert pra ficar visivel.
    let deliveryId: string | undefined;
    try {
      deliveryId = await persistPendingDelivery(job);
    } catch (err) {
      opsAlert("alert_queue_persist_failed", "warning", {
        filter_id: job.filter_id,
        customer_id: job.customer_id,
        channel: job.target.channel,
        error: (err as Error).message,
      });
    }

    let lastResult: DispatchResult & { permanent?: boolean } = { success: false };
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attemptsMade = attempt;
      lastResult = await attemptDelivery(job);
      if (lastResult.success || lastResult.permanent) {
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS[attempt - 1]);
      }
    }

    await writeDeliveryLog(job.filter_id, attemptsMade, lastResult, job.target.channel);

    if (lastResult.success) {
      await recordSuccess(job.customer_id, job.filter_id);
    } else {
      // Falha definitiva (URL bloqueada por SSRF, conta sem email) tambem conta como falha do
      // filtro: o cliente configurou um alvo invalido, e isso deve alimentar o circuit breaker
      // igual qualquer outra falha de entrega.
      await recordFailure(job.customer_id, job.filter_id);
    }

    if (deliveryId) {
      try {
        await removePendingDelivery(deliveryId);
      } catch (err) {
        // Nao propaga: a entrega ja terminou (com sucesso ou falha, ja registrada acima). Pior
        // caso e' o registro ficar orfao na fila durvel e ser reprocessado no proximo boot --
        // redundante (o Idempotency-Key ja protege o endpoint do cliente contra duplicata), nao
        // uma perda de dado.
        opsAlert("alert_queue_cleanup_failed", "warning", {
          delivery_id: deliveryId,
          filter_id: job.filter_id,
          error: (err as Error).message,
        });
      }
    }
  }
}
