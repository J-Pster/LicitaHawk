import { TenderMatchedPayload } from "../common/ports/alert-queue-port";
import { SavedFilter } from "./filter.types";
import { alertQueue } from "./alert-queue.instance";
import { toDeliveryTarget } from "./alert-target";
import { incrementDailyUsage } from "../common/usage-daily.repository";

// Extraido de webhook.router.ts (era local/nao-exportado) pra ser reusado tambem por
// src/account/account-webhooks.router.ts (POST /v1/account/webhooks/:id/test, autenticado por
// Cognito) -- mesmo disparo de teste, sem duplicar a logica em dois lugares. Serve os dois canais:
// filtro de email recebe o mesmo payload, renderizado como email de teste.
function buildSampleTestPayload(filter: SavedFilter): TenderMatchedPayload {
  return {
    event: "tender.matched",
    filter_id: filter.filter_id,
    test: true,
    tender: {
      pncp_control_number: "TESTE-0000/2026",
      org_cnpj: "00000000000000",
      org_name: "Orgao de teste (LicitaHawk)",
      uf: filter.uf,
      modalidade: filter.modalidade,
      objeto: "Este e um disparo de teste pedido manualmente no painel do LicitaHawk.",
      valor_estimado: 0,
      link_pncp: "https://pncp.gov.br/app/editais/teste",
    },
  };
}

export async function dispatchTestWebhook(filter: SavedFilter): Promise<void> {
  // Conta 1 tentativa real de disparo (mesmo criterio de tender-matcher.adapter.ts) -- um teste
  // manual e' tao "uso do recurso" quanto um disparo real casado por um tender novo.
  await incrementDailyUsage(filter.customer_id, filter.channel);
  await alertQueue.enqueue({
    filter_id: filter.filter_id,
    customer_id: filter.customer_id,
    target: toDeliveryTarget(filter),
    payload: buildSampleTestPayload(filter),
    attempt: 1,
    idempotencyKey: `teste-${Date.now()}:${filter.filter_id}`,
  });
}
