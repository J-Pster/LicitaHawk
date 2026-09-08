import { createHash } from "crypto";
import { RequestHandler } from "express";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../dynamodb-client";
import { ApiKeyRecord, PlanTier } from "./types";

const API_KEYS_TABLE = "ApiKeys";
const USAGE_COUNTERS_TABLE = "UsageCounters";

// Limites mensais por plano (item 5.2 do PLAN.md). Billing (Fase 5) e' quem gerencia o plan_tier
// em si; aqui so aplicamos o teto de uso ja definido no plano.
const PLAN_MONTHLY_LIMITS: Record<PlanTier, number> = {
  free: 100,
  starter: 5000,
  pro: 50000,
};

export interface MonthlyUsageResult {
  requestCount: number;
  limit: number;
  exceeded: boolean;
}

/**
 * Incrementa UsageCounters atomicamente (ADD, nunca get-then-put) e informa se o teto mensal do
 * plano foi excedido. Chamada por `clientRateLimit` (client-rate-limit.ts) DEPOIS que o limite
 * por minuto ja foi checado -- Achado real (Rodada 7): antes esse incremento rodava dentro de
 * `authenticate`, ANTES do `clientRateLimit`. Uma rajada que estourasse o limite por minuto (ex.:
 * 40 requisicoes de uma vez num plano Free de 30/min) tinha as 40 contadas contra o teto MENSAL
 * (100/mes no Free) -- incluindo as 10 que nunca foram atendidas de verdade (rejeitadas com 429
 * pelo rate limit por minuto). Confirmado ao vivo: burst de 40 requisicoes -> UsageCounters
 * marcava request_count=40, sendo 10 delas puro 429 sem nenhum dado servido. Corrigido: o
 * incremento mensal so roda depois que a requisicao ja passou pelo limite por minuto, entao uma
 * requisicao barrada por rajada nunca consome quota mensal.
 */
export async function incrementAndCheckMonthlyUsage(customerId: string, planTier: PlanTier): Promise<MonthlyUsageResult> {
  const yyyymm = currentYyyymm();
  const usageRes = await ddbDocClient.send(
    new UpdateCommand({
      TableName: USAGE_COUNTERS_TABLE,
      Key: { customer_id: customerId, yyyymm },
      UpdateExpression: "ADD request_count :inc",
      ExpressionAttributeValues: { ":inc": 1 },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  const requestCount = Number(usageRes.Attributes?.request_count ?? 0);
  const limit = PLAN_MONTHLY_LIMITS[planTier] ?? PLAN_MONTHLY_LIMITS.free;
  return { requestCount, limit, exceeded: requestCount > limit };
}

// Exportado -- reusado por src/account/account.service.ts (provisionamento/regeneracao de API
// key) pra hashear a chave crua com o mesmo algoritmo que este middleware verifica, sem duplicar.
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

// Exportado -- reusado por src/mcp/usage.service.ts (ferramenta MCP get_usage_stats) pra ler o
// mesmo bucket mensal que este middleware incrementa, sem duplicar a regra de formatacao da chave.
export function currentYyyymm(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function extractRawKey(authorizationHeader: string | undefined, apiKeyHeader: string | undefined): string | undefined {
  if (authorizationHeader?.startsWith("Bearer ")) {
    return authorizationHeader.slice("Bearer ".length).trim();
  }
  return apiKeyHeader;
}

/**
 * Autentica por API key (hash SHA-256 armazenado em ApiKeys) e injeta req.auth. NAO incrementa
 * UsageCounters aqui (isso e' feito por `clientRateLimit`, DEPOIS do limite por minuto -- ver
 * `incrementAndCheckMonthlyUsage` acima, achado real da Rodada 7).
 *
 * Achado real de uma rodada anterior: este middleware roda na frente de TODA rota autenticada (e' o
 * codigo mais executado do servico), mas -- diferente das rotas em si (ja protegidas por
 * asyncHandler desde a Rodada 5) -- nao tinha try/catch. Express 4 nao captura rejeicao de
 * Promise em middleware async: uma falha do DynamoDB aqui (endpoint fora do ar, timeout de
 * rede) derrubava o processo inteiro, tirando TODOS os clientes do ar de uma vez -- exatamente
 * a mesma classe de bug ja corrigida nas rotas, mas que sobrevivia intocada no unico lugar que
 * roda em 100% das requisicoes autenticadas. Corrigido envolvendo o corpo em try/catch e
 * repassando pro middleware global de erro via next(err).
 */
export const authenticate: RequestHandler = async (req, res, next) => {
  try {
    const rawKey = extractRawKey(req.header("authorization"), req.header("x-api-key"));

    if (!rawKey) {
      res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "API key ausente. Envie 'Authorization: Bearer <key>' ou 'X-Api-Key: <key>'.",
        },
      });
      return;
    }

    const apiKeyHash = hashApiKey(rawKey);
    const keyRes = await ddbDocClient.send(
      new GetCommand({ TableName: API_KEYS_TABLE, Key: { api_key_hash: apiKeyHash } }),
    );
    const record = keyRes.Item as ApiKeyRecord | undefined;

    if (!record || record.active === false) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "API key invalida." } });
      return;
    }

    // Suporte a multiplas chaves nomeadas com expiracao (src/account/api-keys.service.ts) --
    // sem essa checagem, definir `expires_at` na criacao/edicao da chave nao teria efeito real
    // nenhum (a chave continuaria autenticando pra sempre).
    if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "API key expirada." } });
      return;
    }

    // Teto mensal (UsageCounters) e' checado/incrementado por `clientRateLimit`, nao aqui -- ver
    // `incrementAndCheckMonthlyUsage` acima pro motivo (Rodada 7).
    req.auth = { customer_id: record.customer_id, plan_tier: record.plan_tier };
    next();
  } catch (err) {
    next(err);
  }
};
