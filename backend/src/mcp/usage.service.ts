import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { currentYyyymm } from "../common/auth/api-key.middleware";
import { REQUESTS_PER_MINUTE } from "../common/client-rate-limit";
import { PLANS } from "../billing/plans";
import { PlanTier } from "../common/auth/types";

const USAGE_COUNTERS_TABLE = "UsageCounters";

export interface UsageStats {
  plan: string;
  requestsThisMonth: number;
  monthlyLimit: number;
  monthlyRemaining: number;
  perMinuteLimit: number;
}

/**
 * Leitura pura (GetCommand, mesma chave que `authenticate` incrementa via UpdateCommand ADD --
 * ver api-key.middleware.ts) -- nao incrementa nada, so reflete o estado atual. Usado pela
 * ferramenta MCP `get_usage_stats` pra que o fornecedor nao-tecnico saiba quanto ja consumiu do
 * plano sem precisar olhar fatura/painel (que ainda nao existe, ver sugestao #6 do PLAN.md).
 */
export async function getMonthlyUsage(customerId: string, planTier: PlanTier): Promise<UsageStats> {
  const plan = PLANS[planTier];
  const yyyymm = currentYyyymm();

  const res = await ddbDocClient.send(
    new GetCommand({ TableName: USAGE_COUNTERS_TABLE, Key: { customer_id: customerId, yyyymm } }),
  );
  const requestsThisMonth = Number(res.Item?.request_count ?? 0);

  return {
    plan: plan.name,
    requestsThisMonth,
    monthlyLimit: plan.requestsPerMonth,
    monthlyRemaining: Math.max(0, plan.requestsPerMonth - requestsThisMonth),
    perMinuteLimit: REQUESTS_PER_MINUTE[planTier],
  };
}
