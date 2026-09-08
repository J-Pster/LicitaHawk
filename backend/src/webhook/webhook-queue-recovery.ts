import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { parseSavedFilter } from "./filter.types";
import { listAllPendingDeliveries, removePendingDelivery } from "./webhook-delivery-queue.repository";
import { alertQueue } from "./alert-queue.instance";
import { toDeliveryTarget } from "./alert-target";
import { opsAlert } from "../common/ops-alert";

/**
 * Roda uma unica vez, no boot do processo (ver server.ts). Qualquer item ainda presente em
 * WebhookDeliveryQueue nesse momento e', por definicao, orfao de um processo ANTERIOR que morreu
 * no meio de uma entrega (crash, restart, deploy) -- este processo acabou de subir e ainda nao
 * criou nenhum item propositalmente. Item #5 do PLAN.md: fecha o gap real de "fila em memoria
 * perde tudo em restart", sem precisar de SQS (Fase 7).
 *
 * O alvo da entrega (URL + secret do webhook, ou o canal email) nunca e' persistido na fila (ver
 * webhook-delivery-queue.repository.ts) -- e' remontado aqui a partir do SavedFilter atual. Se o
 * filtro foi deletado enquanto a entrega estava pendente, o registro orfao e' apenas descartado
 * (nao ha mais pra onde entregar).
 */
export async function recoverPendingWebhookDeliveries(): Promise<void> {
  let pending: Awaited<ReturnType<typeof listAllPendingDeliveries>>;
  try {
    pending = await listAllPendingDeliveries();
  } catch (err) {
    opsAlert("alert_queue_recovery_scan_failed", "critical", { error: (err as Error).message });
    return;
  }

  if (pending.length === 0) {
    return;
  }

  console.log(`[alert-queue-recovery] ${pending.length} entrega(s) pendente(s) de um processo anterior, recuperando...`);

  for (const item of pending) {
    try {
      const filterRes = await ddbDocClient.send(
        new GetCommand({
          TableName: "SavedFilters",
          Key: { customer_id: item.customer_id, filter_id: item.filter_id },
        }),
      );
      if (!filterRes.Item) {
        console.warn(
          `[alert-queue-recovery] filtro ${item.filter_id} nao existe mais, descartando entrega orfa ${item.delivery_id}`,
        );
        await removePendingDelivery(item.delivery_id);
        continue;
      }
      const filter = parseSavedFilter(filterRes.Item as Record<string, unknown>);

      // Reenfileira via o mesmo caminho normal (enqueue ja persiste de novo + reprocessa retry
      // completo) -- o registro orfao original e' removido primeiro pra nao duplicar na tabela
      // durvel enquanto a nova tentativa roda. O Idempotency-Key e' reaproveitado do job
      // original: se a entrega original tiver chegado no destino antes do crash, o servidor do
      // cliente ja deve dedupar por esse header (mesma garantia documentada na Fase 4.2).
      await removePendingDelivery(item.delivery_id);
      alertQueue
        .enqueue({
          filter_id: filter.filter_id,
          customer_id: filter.customer_id,
          target: toDeliveryTarget(filter),
          payload: item.payload,
          attempt: 1,
          idempotencyKey: item.idempotencyKey,
        })
        .catch((err) =>
          opsAlert("alert_queue_recovery_redeliver_failed", "warning", {
            filter_id: item.filter_id,
            delivery_id: item.delivery_id,
            error: (err as Error).message,
          }),
        );
    } catch (err) {
      opsAlert("alert_queue_recovery_item_failed", "warning", {
        delivery_id: item.delivery_id,
        filter_id: item.filter_id,
        error: (err as Error).message,
      });
    }
  }
}
