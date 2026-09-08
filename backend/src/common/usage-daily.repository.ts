import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "./dynamodb-client";

const USAGE_DAILY_TABLE = "UsageDaily";
const TTL_DAYS = 60;
const RETENTION_DAYS = 30;

export type UsageKind = "api" | "mcp" | "ui" | "webhook" | "email";

const FIELD_BY_KIND: Record<UsageKind, string> = {
  api: "api_count",
  mcp: "mcp_count",
  ui: "ui_count",
  webhook: "webhook_count",
  email: "email_count",
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Ultimos 30 dias (incluindo hoje), do mais antigo pro mais recente -- ex.: ["2026-08-08", ..., "2026-09-07"]. */
export function last30DayDates(): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = RETENTION_DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Incrementa o contador diario (API/MCP/UI/Webhook) do dia corrente via UpdateItem ADD (mesmo
 * padrao atomico de UsageCounters/ClientRateLimits). Chamado por client-rate-limit.ts (surfaces
 * "api"/"mcp") e por src/account/account-playground.router.ts (surface "ui") logo apos o
 * incremento mensal ja existente, e pelos pontos reais de disparo de webhook (surface "webhook",
 * ver tender-matcher.adapter.ts/webhook-test-dispatch.ts) -- e' telemetria pro dashboard
 * (graficos), NUNCA pode derrubar ou atrasar a requisicao/disparo real do cliente por causa de
 * uma falha aqui, entao engole o erro (so loga) em vez de propagar.
 */
export async function incrementDailyUsage(customerId: string, kind: UsageKind): Promise<void> {
  try {
    const date = todayIso();
    const ttl = Math.floor(Date.now() / 1000) + TTL_DAYS * 24 * 60 * 60;
    const field = FIELD_BY_KIND[kind];
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: USAGE_DAILY_TABLE,
        Key: { customer_id: customerId, date },
        UpdateExpression: `ADD ${field} :inc SET #ttl = if_not_exists(#ttl, :ttlVal)`,
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":inc": 1, ":ttlVal": ttl },
      }),
    );
  } catch (err) {
    console.error("[usage-daily] falha ao incrementar uso diario (nao afeta a requisicao)", err);
  }
}

export interface DailyUsageCounts {
  api_count: number;
  mcp_count: number;
  ui_count: number;
  webhook_count: number;
  email_count: number;
}

/** Query direta (customer_id + date entre os limites da janela de 30 dias) -- sem zero-fill, quem
 * chama (account.service.ts::getAccountDailyUsage) preenche os dias sem linha. */
export async function getDailyUsageForLast30Days(customerId: string): Promise<Map<string, DailyUsageCounts>> {
  const dates = last30DayDates();
  const res = await ddbDocClient.send(
    new QueryCommand({
      TableName: USAGE_DAILY_TABLE,
      KeyConditionExpression: "customer_id = :cid AND #d BETWEEN :start AND :end",
      ExpressionAttributeNames: { "#d": "date" },
      ExpressionAttributeValues: { ":cid": customerId, ":start": dates[0], ":end": dates[dates.length - 1] },
    }),
  );

  const map = new Map<string, DailyUsageCounts>();
  for (const item of res.Items ?? []) {
    map.set(item.date as string, {
      api_count: Number(item.api_count ?? 0),
      mcp_count: Number(item.mcp_count ?? 0),
      ui_count: Number(item.ui_count ?? 0),
      webhook_count: Number(item.webhook_count ?? 0),
      email_count: Number(item.email_count ?? 0),
    });
  }
  return map;
}
