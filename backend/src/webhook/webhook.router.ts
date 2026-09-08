import { Router, Request, Response } from "express";
import { assertFilterOwnership, FilterNotFoundError } from "../common/filter-ownership";
import { authenticate } from "../common/auth/api-key.middleware";
import { clientRateLimit } from "../common/client-rate-limit";
import { asyncHandler } from "../common/async-handler";
import { HttpError } from "../common/http-error";
import { FilterNotDisabledError, reactivateFilter } from "./circuit-breaker";
import { dispatchTestWebhook } from "./webhook-test-dispatch";
// Augmenta Express.Request com req.auth (customer_id/plan_tier) -- contrato real do middleware
// de autenticacao da Fase 3 (src/common/auth/api-key.middleware.ts).
import "../common/auth/types";

// Router de webhook de teste (Fase 4.4). Registrado em src/server.ts junto com os demais.
export const webhookRouter = Router();

// authenticate aplicado POR ROTA (mesmo padrao de tenders.router.ts/filters.router.ts) -- corrige
// integracao: essa rota nao tinha auth aplicada, entao req.auth nunca era populado antes de montar
// os routers juntos em server.ts (achado do team-lead na integracao final).
// Rodada 4: migrado pra asyncHandler + HttpError -- alinha o formato de erro com o resto da API
// ({error:{code,message}}, ver src/common/http-error.ts), fechando a lacuna documentada na
// Rodada 2 do PLAN.md ("billing/webhook ainda respondem no formato antigo").
// Rodada 5: `clientRateLimit` estava ausente aqui e em /reactivate abaixo -- toda outra rota
// autenticada da API (tenders, filtros, /mcp desde a Rodada 3) aplica o limite por minuto logo
// apos `authenticate`; essas duas ficavam de fora, reabrindo a mesma classe de brecha de rajada
// que as Rodadas 2/3 ja tinham fechado no resto da API.
webhookRouter.post(
  "/v1/filters/:id/test",
  authenticate,
  clientRateLimit,
  asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth?.customer_id;
    if (!customerId) {
      throw new HttpError(401, "unauthorized", "UNAUTHORIZED");
    }

    let filter;
    try {
      // Mesma checagem de IDOR das outras rotas de filtro (ver src/common/filter-ownership.ts).
      filter = await assertFilterOwnership(customerId, req.params.id);
    } catch (err) {
      if (err instanceof FilterNotFoundError) {
        throw new HttpError(404, "filter not found", "NOT_FOUND");
      }
      throw err;
    }

    await dispatchTestWebhook(filter);

    res.status(202).json({ status: "queued" });
  }),
);

// Novo nesta rodada (fecha um gap real do circuit breaker -- ver comentario em
// circuit-breaker.ts/reactivateFilter): sem isso, um filtro desativado por excesso de falhas
// consecutivas ficava morto pra sempre, mesmo depois do cliente corrigir o endpoint.
webhookRouter.post(
  "/v1/filters/:id/reactivate",
  authenticate,
  clientRateLimit,
  asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth?.customer_id;
    if (!customerId) {
      throw new HttpError(401, "unauthorized", "UNAUTHORIZED");
    }

    try {
      // IDOR: garante que o filtro e' do proprio cliente antes de tentar reativar.
      await assertFilterOwnership(customerId, req.params.id);
    } catch (err) {
      if (err instanceof FilterNotFoundError) {
        throw new HttpError(404, "filter not found", "NOT_FOUND");
      }
      throw err;
    }

    try {
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
