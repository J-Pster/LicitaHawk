import { Router } from "express";
import { cognitoAuthenticate } from "../common/auth/cognito-auth.middleware";
import { asyncHandler } from "../common/async-handler";
import { HttpError } from "../common/http-error";
import { assertValidWebhookUrl } from "../common/query-validation";
import { assertFilterOwnership, FilterNotFoundError } from "../common/filter-ownership";
import { SavedWebhookFilter } from "../webhook/filter.types";
import { dispatchTestWebhook } from "../webhook/webhook-test-dispatch";
import { FilterNotDisabledError, reactivateFilter } from "../webhook/circuit-breaker";
import {
  createFilter,
  deleteOwnedFilter,
  listDeliveriesForOwnedFilter,
  listFiltersByChannel,
  regenerateFilterSecret,
  updateOwnedFilter,
} from "../filters/filters.service";
import {
  assertCanCreateFilter,
  assertChannel,
  assertValidCriteria,
  requirePlan,
} from "./filter-routes.common";

// Router de webhooks (filtros salvos com canal "webhook") via CONTA -- mesmo CRUD que /v1/filters
// (Fase 3/4) ja oferece, mas autenticado por ID token do Cognito (req.cognitoUser.sub) em vez de
// API key (req.auth.customer_id): o dashboard nao pode pedir pro usuario digitar a propria API key
// so pra gerenciar os webhooks dele. Reusa filters.service.ts inteiro -- nunca duplica a logica de
// CRUD/dispatch/circuit-breaker, so troca de onde vem o customer_id.
//
// Esta colecao ve APENAS o canal webhook. Alerta por email mora em account-alerts.router.ts, sobre
// a mesma tabela e o mesmo servico -- o que separa as duas e' o canal de entrega.
export const accountWebhooksRouter = Router();

function toAccountWebhook(filter: SavedWebhookFilter) {
  return {
    id: filter.filter_id,
    name: filter.name ?? null,
    uf: filter.uf,
    modalidade: filter.modalidade,
    keyword: filter.keyword,
    webhook_url: filter.webhook_url,
    active: filter.active,
    consecutive_failures: filter.consecutive_failures,
    created_at: filter.created_at,
  };
}

/** Busca o filtro garantindo dono E canal -- id de alerta por email nao existe nesta colecao. */
async function findOwnedWebhook(customerId: string, filterId: string): Promise<SavedWebhookFilter> {
  try {
    const filter = await assertFilterOwnership(customerId, filterId);
    return assertChannel(filter, "webhook");
  } catch (err) {
    if (err instanceof FilterNotFoundError) {
      throw new HttpError(404, "filtro nao encontrado", "NOT_FOUND");
    }
    throw err;
  }
}

accountWebhooksRouter.get(
  "/v1/account/webhooks",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const filters = await listFiltersByChannel(req.cognitoUser!.sub, "webhook");
    res.json({ data: filters.map((filter) => toAccountWebhook(filter as SavedWebhookFilter)) });
  }),
);

accountWebhooksRouter.post(
  "/v1/account/webhooks",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const customerId = req.cognitoUser!.sub;
    const { uf, modalidade, keyword, webhook_url: webhookUrl, name } = (req.body ?? {}) as {
      uf?: string;
      modalidade?: string;
      keyword?: string;
      webhook_url?: string;
      name?: string;
    };

    if (!uf || !modalidade || !webhookUrl) {
      throw new HttpError(400, "uf, modalidade e webhook_url sao obrigatorios", "VALIDATION_ERROR");
    }
    if (typeof uf !== "string" || typeof modalidade !== "string" || typeof webhookUrl !== "string") {
      throw new HttpError(400, "uf, modalidade e webhook_url devem ser strings", "VALIDATION_ERROR");
    }
    // Mesma validacao de filters.router.ts (query-validation.ts) -- nao duplicada aqui, so reusada.
    assertValidCriteria(uf, modalidade);
    assertValidWebhookUrl(webhookUrl);

    const plan = await requirePlan(customerId);
    await assertCanCreateFilter(customerId, plan);

    const filter = await createFilter(customerId, {
      channel: "webhook",
      uf: uf.toUpperCase(),
      modalidade,
      keyword,
      webhook_url: webhookUrl,
      name: name ?? null,
    });
    res.status(201).json({ data: toAccountWebhook(filter as SavedWebhookFilter) });
  }),
);

accountWebhooksRouter.patch(
  "/v1/account/webhooks/:id",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const { name, webhook_url: webhookUrl } = (req.body ?? {}) as { name?: string | null; webhook_url?: string };

    if (webhookUrl !== undefined) {
      if (typeof webhookUrl !== "string") {
        throw new HttpError(400, "webhook_url deve ser string", "VALIDATION_ERROR");
      }
      assertValidWebhookUrl(webhookUrl);
    }
    if (name === undefined && webhookUrl === undefined) {
      throw new HttpError(400, "informe ao menos 'name' ou 'webhook_url' para atualizar", "VALIDATION_ERROR");
    }

    await findOwnedWebhook(req.cognitoUser!.sub, req.params.id);
    const updated = await updateOwnedFilter(req.cognitoUser!.sub, req.params.id, {
      name: name === undefined ? undefined : name === null ? null : String(name).trim(),
      webhook_url: webhookUrl,
    });
    if (!updated) {
      throw new HttpError(404, "filtro nao encontrado", "NOT_FOUND");
    }
    res.json({ data: toAccountWebhook(updated as SavedWebhookFilter) });
  }),
);

accountWebhooksRouter.delete(
  "/v1/account/webhooks/:id",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    await findOwnedWebhook(req.cognitoUser!.sub, req.params.id);
    const deleted = await deleteOwnedFilter(req.cognitoUser!.sub, req.params.id);
    if (!deleted) {
      throw new HttpError(404, "filtro nao encontrado", "NOT_FOUND");
    }
    res.status(204).send();
  }),
);

accountWebhooksRouter.post(
  "/v1/account/webhooks/:id/test",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const filter = await findOwnedWebhook(req.cognitoUser!.sub, req.params.id);

    // Mesmo dispatcher de teste que POST /v1/filters/:id/test (webhook.router.ts) -- nunca duplicado.
    await dispatchTestWebhook(filter);

    res.status(202).json({ status: "queued" });
  }),
);

accountWebhooksRouter.post(
  "/v1/account/webhooks/:id/reactivate",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const customerId = req.cognitoUser!.sub;
    await findOwnedWebhook(customerId, req.params.id);

    try {
      // Mesma logica de circuit breaker que POST /v1/filters/:id/reactivate (circuit-breaker.ts).
      await reactivateFilter(customerId, req.params.id);
    } catch (err) {
      if (err instanceof FilterNotDisabledError) {
        throw new HttpError(409, "filtro nao esta desativado por circuit breaker", "FILTER_NOT_DISABLED");
      }
      throw err;
    }

    res.status(200).json({ status: "reactivated" });
  }),
);

// Feed de entregas REAIS do webhook (nao a simulacao de /webhook-preview do Playground) -- mesmo
// dado que GET /v1/filters/:id/deliveries (autenticado por API key) ja expoe, so trocando de onde
// vem o customer_id (Cognito em vez de req.auth). Nunca duplica listDeliveriesForOwnedFilter.
accountWebhooksRouter.get(
  "/v1/account/webhooks/:id/deliveries",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    await findOwnedWebhook(req.cognitoUser!.sub, req.params.id);
    const { deliveries } = await listDeliveriesForOwnedFilter(req.cognitoUser!.sub, req.params.id);
    res.json({ data: deliveries });
  }),
);

accountWebhooksRouter.post(
  "/v1/account/webhooks/:id/regenerate-secret",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    await findOwnedWebhook(req.cognitoUser!.sub, req.params.id);
    const ok = await regenerateFilterSecret(req.cognitoUser!.sub, req.params.id);
    if (!ok) {
      throw new HttpError(404, "filtro nao encontrado", "NOT_FOUND");
    }
    res.json({ data: { id: req.params.id, secret_regenerated: true } });
  }),
);
