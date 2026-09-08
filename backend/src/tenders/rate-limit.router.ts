import { Router } from "express";
import { asyncHandler } from "../common/async-handler";
import { getRateLimitSummary } from "./rate-limit-tracking";

/**
 * Rota operacional (item 4 desta rodada) pra consultar as metricas agregadas de rate-limit
 * tracking do PNCP -- nao e' dado de produto/cliente, entao fica sem auth por API key de
 * proposito (nao conta pra UsageCounters/plano, ver api-key.middleware.ts), equivalente
 * operacional a /health. Revisar (colocar atras de auth de operador) antes de expor publicamente
 * em producao -- Fase 7, fora do escopo desta rodada.
 */
export const rateLimitRouter = Router();

rateLimitRouter.get(
  "/internal/rate-limit-metrics",
  asyncHandler(async (_req, res) => {
    const summary = await getRateLimitSummary();
    res.json(summary);
  }),
);
