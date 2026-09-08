import { Router } from "express";
import { authenticate } from "../common/auth/api-key.middleware";
import {
  createFilter,
  deleteOwnedFilter,
  listDeliveriesForOwnedFilter,
  listFiltersForCustomer,
} from "./filters.service";
import { toPublicFilter } from "../common/public-filter";
import { asyncHandler } from "../common/async-handler";
import { clientRateLimit } from "../common/client-rate-limit";
import { HttpError } from "../common/http-error";
import { assertValidUf, assertValidWebhookUrl } from "../common/query-validation";
import { PLANS } from "../billing/plans";

// Router de filtros salvos (Fase 3.1). Exportado standalone -- o team-lead registra em
// src/server.ts. Toda rota com filter_id valida dono via req.auth.customer_id (protecao IDOR,
// reusando assertFilterOwnership de src/common/filter-ownership.ts, compartilhado com a Fase 4).
export const filtersRouter = Router();

// authenticate e clientRateLimit sao aplicados POR ROTA (nunca via router.use() sem path) -- ver
// comentario equivalente em tenders.router.ts: com varios routers montados juntos na raiz do
// app, um router.use() sem path autenticaria (e cobraria uso) em duplicidade pra toda requisicao.
// asyncHandler evita que um erro nao tratado (ex.: DynamoDB fora do ar) derrube o processo
// inteiro (Express 4 nao captura rejeicao de Promise em handler async sozinho).

filtersRouter.post(
  "/v1/filters",
  authenticate,
  clientRateLimit,
  asyncHandler(async (req, res) => {
    const { uf, modalidade, keyword, webhook_url: webhookUrl } = req.body ?? {};
    if (!uf || !modalidade || !webhookUrl) {
      throw new HttpError(400, "uf, modalidade e webhook_url sao obrigatorios", "VALIDATION_ERROR");
    }
    if (typeof uf !== "string" || typeof modalidade !== "string" || typeof webhookUrl !== "string") {
      throw new HttpError(400, "uf, modalidade e webhook_url devem ser strings", "VALIDATION_ERROR");
    }
    // Achado real: nada validava o formato de uf/webhook_url na criacao -- um valor malformado
    // so falhava (silenciosamente pro cliente) na hora do primeiro disparo de webhook, la no
    // dispatcher (Fase 4). Agora o erro aparece na criacao, de forma explicita.
    assertValidUf(uf);
    assertValidWebhookUrl(webhookUrl);

    // Enforcement de plano (achado real da revisao de qualidade: antes disso, Free criava
    // webhook ilimitado de graca -- os campos de plans.ts existiam mas nunca eram checados).
    const plan = PLANS[req.auth!.plan_tier];
    if (!plan.webhooksEnabled) {
      throw new HttpError(403, `plano ${plan.name} nao inclui alertas por webhook`, "PLAN_LIMIT_EXCEEDED");
    }
    const existing = await listFiltersForCustomer(req.auth!.customer_id);
    if (existing.length >= plan.maxFilters) {
      throw new HttpError(403, `limite de ${plan.maxFilters} filtro(s) do plano ${plan.name} atingido`, "PLAN_LIMIT_EXCEEDED");
    }

    const filter = await createFilter(req.auth!.customer_id, { channel: "webhook", uf: uf.toUpperCase(), modalidade, keyword, webhook_url: webhookUrl });
    res.status(201).json({ data: toPublicFilter(filter) });
  }),
);

filtersRouter.get(
  "/v1/filters",
  authenticate,
  clientRateLimit,
  asyncHandler(async (req, res) => {
    const filters = await listFiltersForCustomer(req.auth!.customer_id);
    res.json({ data: filters.map(toPublicFilter) });
  }),
);

filtersRouter.delete(
  "/v1/filters/:id",
  authenticate,
  clientRateLimit,
  asyncHandler(async (req, res) => {
    const deleted = await deleteOwnedFilter(req.auth!.customer_id, req.params.id);
    if (!deleted) {
      throw new HttpError(404, "filtro nao encontrado", "NOT_FOUND");
    }
    res.status(204).send();
  }),
);

filtersRouter.get(
  "/v1/filters/:id/deliveries",
  authenticate,
  clientRateLimit,
  asyncHandler(async (req, res) => {
    const { found, deliveries } = await listDeliveriesForOwnedFilter(req.auth!.customer_id, req.params.id);
    if (!found) {
      throw new HttpError(404, "filtro nao encontrado", "NOT_FOUND");
    }
    res.json({ data: deliveries });
  }),
);
