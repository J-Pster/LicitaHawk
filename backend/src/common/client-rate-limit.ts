import { RequestHandler, Response } from "express";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "./dynamodb-client";
import { incrementAndCheckMonthlyUsage, MonthlyUsageResult } from "./auth/api-key.middleware";
import { incrementDailyUsage, UsageKind } from "./usage-daily.repository";
import { PlanTier } from "./auth/types";

const CLIENT_RATE_LIMITS_TABLE = "ClientRateLimits";
const WINDOW_TTL_SECONDS = 120;

// Protege o proprio servico contra rajada de UM cliente -- distinto do teto MENSAL de uso
// (UsageCounters). Backed por DynamoDB, nao memoria de processo,
// de proposito: em producao (Fase 7) cada request pode cair numa instancia Lambda diferente; um
// limitador em memoria local nao enxergaria rajada distribuida entre instancias. Mesmo padrao de
// `UpdateCommand ADD` atomico ja usado em UsageCounters (api-key.middleware.ts) e
// RateLimitMetrics (rate-limit-tracking.ts).
// Exportado -- reusado por src/mcp/usage.service.ts (ferramenta MCP get_usage_stats) pra informar
// o limite por minuto do plano do cliente sem duplicar a tabela aqui.
export const REQUESTS_PER_MINUTE: Record<PlanTier, number> = {
  free: 30,
  starter: 180,
  pro: 600,
};

function currentWindowKey(): string {
  // Janela fixa de 1 minuto (UTC), ex. "min#202609071423".
  return `min#${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
}

export interface UsageEnforcementResult {
  limit: number;
  count: number;
  rateLimited: boolean;
  // Ausente quando rateLimited=true (o incremento mensal so roda depois de passar no limite por
  // minuto -- ver comentario de enforceUsage abaixo).
  monthly?: MonthlyUsageResult;
}

/**
 * Nucleo reusavel do rate limit por minuto + teto mensal + uso diario, recebendo customerId/
 * planTier diretamente (sem depender de req.auth) -- extraido pra ser chamado tanto por
 * `clientRateLimit` (rotas de API key, via req.auth, surface "api"/"mcp") quanto por
 * `enforceUsageForCognitoAccount` (src/account/account-playground.router.ts, rotas do Playground/
 * Dashboard autenticadas por Cognito, surface "ui"). E' a MESMA cota/limite do plano do cliente
 * nos dois casos -- o Playground usa a API real dele pela nossa UI em vez de curl, entao precisa
 * contar pro mesmo lugar, senao vira um jeito de furar o limite; so o rastreamento diario (pro
 * grafico do dashboard) separa as duas surfaces.
 *
 * Ordem importa (achado real da Rodada 7, ver incrementAndCheckMonthlyUsage): so incrementa a
 * quota MENSAL depois de confirmar que a requisicao passou no limite por minuto -- uma rajada
 * barrada por minuto nunca deve consumir quota mensal.
 */
export async function enforceUsage(customerId: string, planTier: PlanTier, surface: UsageKind): Promise<UsageEnforcementResult> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const result = await ddbDocClient.send(
    new UpdateCommand({
      TableName: CLIENT_RATE_LIMITS_TABLE,
      Key: { customer_id: customerId, window: currentWindowKey() },
      UpdateExpression: "ADD request_count :inc SET #ttl = if_not_exists(#ttl, :ttlVal)",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":inc": 1, ":ttlVal": nowSeconds + WINDOW_TTL_SECONDS },
      ReturnValues: "UPDATED_NEW",
    }),
  );

  const count = Number(result.Attributes?.request_count ?? 0);
  const limit = REQUESTS_PER_MINUTE[planTier] ?? REQUESTS_PER_MINUTE.free;

  if (count > limit) {
    return { limit, count, rateLimited: true };
  }

  const monthly = await incrementAndCheckMonthlyUsage(customerId, planTier);
  // Nunca lanca (ver usage-daily.repository.ts) -- telemetria pro dashboard, nao pode atrasar/
  // derrubar a requisicao real do cliente.
  await incrementDailyUsage(customerId, surface);

  return { limit, count, rateLimited: false, monthly };
}

/**
 * Aplica os headers de rate limit e, se aplicavel, ja envia a resposta 429 (por-minuto ou
 * mensal). Retorna true se a resposta ja foi enviada (o middleware chamador deve parar sem
 * chamar next()) -- reusada por `clientRateLimit` e `enforceUsageForCognitoAccount` pra nao
 * duplicar o formato de erro/headers em dois lugares.
 */
export function respondIfUsageExceeded(res: Response, result: UsageEnforcementResult, planTier: PlanTier): boolean {
  res.setHeader("X-RateLimit-Limit", String(result.limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, result.limit - result.count)));

  if (result.rateLimited) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: `Limite de ${result.limit} requisicoes/minuto excedido para o plano ${planTier}. Tente novamente em instantes.`,
      },
    });
    return true;
  }

  if (result.monthly!.exceeded) {
    res.setHeader("Retry-After", "3600");
    res.status(429).json({
      error: {
        code: "PLAN_LIMIT_EXCEEDED",
        message: `Limite mensal do plano '${planTier}' excedido (${result.monthly!.limit} requisicoes/mes).`,
      },
    });
    return true;
  }

  return false;
}

/**
 * Roda SEMPRE depois de `authenticate` (precisa de req.auth.customer_id). Aplicado por rota,
 * nao via router.use() -- mesmo motivo documentado em tenders.router.ts/filters.router.ts.
 */
export const clientRateLimit: RequestHandler = async (req, res, next) => {
  try {
    const auth = req.auth;
    if (!auth) {
      next();
      return;
    }

    // `req.path` reflete o path real da rota (o router de MCP e' montado direto na raiz do
    // app, sem prefixo). Rotas aqui sao sempre autenticadas por API KEY de verdade -- "api",
    // nao "rest" (que era ambiguo e passou a contar tambem o uso via Cognito do proprio
    // dashboard, corrigido separando essa surface em "ui", ver account-playground.router.ts).
    const surface: UsageKind = req.path === "/mcp" ? "mcp" : "api";
    const result = await enforceUsage(auth.customer_id, auth.plan_tier, surface);

    if (respondIfUsageExceeded(res, result, auth.plan_tier)) {
      return;
    }

    next();
  } catch (err) {
    // Mesma logica de asyncHandler: nao deixar a excecao escapar sem tratamento e derrubar o
    // processo. Cai no middleware global de erro (server.ts).
    next(err);
  }
};
