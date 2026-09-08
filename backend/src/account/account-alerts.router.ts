import { Router } from "express";
import { cognitoAuthenticate } from "../common/auth/cognito-auth.middleware";
import { asyncHandler } from "../common/async-handler";
import { HttpError } from "../common/http-error";
import { assertValidWebhookUrl } from "../common/query-validation";
import { assertFilterOwnership, FilterNotFoundError } from "../common/filter-ownership";
import { SavedEmailFilter, SavedWebhookFilter } from "../webhook/filter.types";
import { dispatchTestWebhook } from "../webhook/webhook-test-dispatch";
import { FilterNotDisabledError, reactivateFilter } from "../webhook/circuit-breaker";
import {
  createFilter,
  deleteOwnedFilter,
  listDeliveriesForOwnedFilter,
  listFiltersByChannel,
  updateOwnedFilter,
} from "../filters/filters.service";
import {
  assertCanCreateFilter,
  assertChannel,
  assertValidCriteria,
  requireAccountEmail,
  requirePlan,
} from "./filter-routes.common";

/**
 * Alertas por email: o mesmo criterio de disparo de um webhook (uf + modalidade + keyword), so que
 * a entrega e' um email para o dono da conta em vez de um POST num endpoint. Roda sobre a MESMA
 * tabela e o MESMO servico de filtros que account-webhooks.router.ts, e o disparo passa pela mesma
 * fila (retry, circuit breaker, log de entregas) -- a diferenca inteira e' o canal.
 *
 * O destinatario nunca vem do request: e' sempre o email da conta (claim do Cognito), resolvido no
 * momento do envio. Aceitar um endereco arbitrario aqui transformaria o dominio verificado do
 * LicitaHawk num relay de email para terceiros.
 */
export const accountAlertsRouter = Router();

function toAccountAlert(filter: SavedEmailFilter) {
  return {
    id: filter.filter_id,
    name: filter.name ?? null,
    uf: filter.uf,
    modalidade: filter.modalidade,
    keyword: filter.keyword,
    channel: "email" as const,
    active: filter.active,
    consecutive_failures: filter.consecutive_failures,
    created_at: filter.created_at,
  };
}

/** Busca o alerta garantindo dono E canal -- id de webhook nao existe nesta colecao. */
async function findOwnedAlert(customerId: string, filterId: string): Promise<SavedEmailFilter> {
  try {
    const filter = await assertFilterOwnership(customerId, filterId);
    return assertChannel(filter, "email");
  } catch (err) {
    if (err instanceof FilterNotFoundError) {
      throw new HttpError(404, "alerta nao encontrado", "NOT_FOUND");
    }
    throw err;
  }
}

accountAlertsRouter.get(
  "/v1/account/alerts",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const filters = await listFiltersByChannel(req.cognitoUser!.sub, "email");
    res.json({ data: filters.map((filter) => toAccountAlert(filter as SavedEmailFilter)) });
  }),
);

accountAlertsRouter.post(
  "/v1/account/alerts",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const customerId = req.cognitoUser!.sub;
    const { uf, modalidade, keyword, name } = (req.body ?? {}) as {
      uf?: string;
      modalidade?: string;
      keyword?: string;
      name?: string;
    };

    if (!uf || !modalidade) {
      throw new HttpError(400, "uf e modalidade sao obrigatorios", "VALIDATION_ERROR");
    }
    if (typeof uf !== "string" || typeof modalidade !== "string") {
      throw new HttpError(400, "uf e modalidade devem ser strings", "VALIDATION_ERROR");
    }
    assertValidCriteria(uf, modalidade);

    const plan = await requirePlan(customerId);
    await assertCanCreateFilter(customerId, plan);
    // Falha aqui, na criacao, se a conta nao tem email -- melhor que criar um alerta que so
    // descobre que nao tem destinatario no primeiro disparo real.
    await requireAccountEmail(customerId);

    const filter = await createFilter(customerId, {
      channel: "email",
      uf: uf.toUpperCase(),
      modalidade,
      keyword,
      name: name ?? null,
    });
    res.status(201).json({ data: toAccountAlert(filter as SavedEmailFilter) });
  }),
);

accountAlertsRouter.patch(
  "/v1/account/alerts/:id",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const { name } = (req.body ?? {}) as { name?: string | null };
    if (name === undefined) {
      throw new HttpError(400, "informe 'name' para atualizar", "VALIDATION_ERROR");
    }

    await findOwnedAlert(req.cognitoUser!.sub, req.params.id);
    const updated = await updateOwnedFilter(req.cognitoUser!.sub, req.params.id, {
      name: name === null ? null : String(name).trim(),
    });
    if (!updated) {
      throw new HttpError(404, "alerta nao encontrado", "NOT_FOUND");
    }
    res.json({ data: toAccountAlert(updated as SavedEmailFilter) });
  }),
);

accountAlertsRouter.delete(
  "/v1/account/alerts/:id",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    await findOwnedAlert(req.cognitoUser!.sub, req.params.id);
    const deleted = await deleteOwnedFilter(req.cognitoUser!.sub, req.params.id);
    if (!deleted) {
      throw new HttpError(404, "alerta nao encontrado", "NOT_FOUND");
    }
    res.status(204).send();
  }),
);

// Mesmo disparo de teste do webhook, mesmo payload -- so que renderizado como email.
accountAlertsRouter.post(
  "/v1/account/alerts/:id/test",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const customerId = req.cognitoUser!.sub;
    const filter = await findOwnedAlert(customerId, req.params.id);
    const email = await requireAccountEmail(customerId);

    await dispatchTestWebhook(filter);

    res.status(202).json({ status: "queued", email });
  }),
);

accountAlertsRouter.post(
  "/v1/account/alerts/:id/reactivate",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const customerId = req.cognitoUser!.sub;
    await findOwnedAlert(customerId, req.params.id);

    try {
      await reactivateFilter(customerId, req.params.id);
    } catch (err) {
      if (err instanceof FilterNotDisabledError) {
        throw new HttpError(409, "alerta nao esta desativado por circuit breaker", "FILTER_NOT_DISABLED");
      }
      throw err;
    }

    res.status(200).json({ status: "reactivated" });
  }),
);

accountAlertsRouter.get(
  "/v1/account/alerts/:id/deliveries",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    await findOwnedAlert(req.cognitoUser!.sub, req.params.id);
    const { deliveries } = await listDeliveriesForOwnedFilter(req.cognitoUser!.sub, req.params.id);
    res.json({ data: deliveries });
  }),
);

/**
 * "Copiar para um webhook": cria um webhook com o MESMO criterio do alerta, mudando so o canal. Os
 * criterios vem do alerta guardado, nunca do request -- se viessem do cliente, a copia poderia
 * divergir do original em silencio e as duas telas mostrariam recortes diferentes do mesmo alerta.
 * O webhook nasce independente: editar ou excluir um nao mexe no outro.
 */
accountAlertsRouter.post(
  "/v1/account/alerts/:id/copy-to-webhook",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const customerId = req.cognitoUser!.sub;
    const { webhook_url: webhookUrl, name } = (req.body ?? {}) as { webhook_url?: string; name?: string };

    if (!webhookUrl || typeof webhookUrl !== "string") {
      throw new HttpError(400, "webhook_url e obrigatorio", "VALIDATION_ERROR");
    }
    assertValidWebhookUrl(webhookUrl);

    const alert = await findOwnedAlert(customerId, req.params.id);
    const plan = await requirePlan(customerId);
    await assertCanCreateFilter(customerId, plan);

    const filter = (await createFilter(customerId, {
      channel: "webhook",
      uf: alert.uf,
      modalidade: alert.modalidade,
      keyword: alert.keyword,
      webhook_url: webhookUrl,
      name: name?.trim() || alert.name,
    })) as SavedWebhookFilter;

    res.status(201).json({
      data: {
        id: filter.filter_id,
        name: filter.name,
        uf: filter.uf,
        modalidade: filter.modalidade,
        keyword: filter.keyword,
        webhook_url: filter.webhook_url,
        active: filter.active,
        consecutive_failures: filter.consecutive_failures,
        created_at: filter.created_at,
      },
    });
  }),
);
