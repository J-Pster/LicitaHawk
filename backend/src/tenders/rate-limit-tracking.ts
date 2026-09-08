import { randomUUID } from "crypto";
import { BatchGetCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";

const EVENTS_TABLE = "RateLimitEvents";
const METRICS_TABLE = "RateLimitMetrics";
const EVENTS_TTL_DAYS = 14;
const GLOBAL_STATE_KEY = "state#global";

// Escolha de design (item 1 desta rodada, ver PLAN.md): a API do PNCP nao documenta rate limit
// nenhum -- Notas de Execucao #1 so confirma empiricamente que ele existe. Duas tabelas, nao uma:
// - RateLimitEvents: evento bruto por TENTATIVA de chamada (sucesso ou falha), TTL de 14 dias --
//   serve pra forense pontual ("o que aconteceu as 14h32 de terca"), mas nunca e' o caminho de
//   leitura pra pergunta agregada (isso seria Scan, caro e lento com o tempo).
// - RateLimitMetrics: contadores agregados por bucket (dia/hora/modalidade), atualizados
//   atomicamente (UpdateCommand ADD) na MESMA chamada que grava o evento bruto. Toda pergunta tipo
//   "quantos 429 na ultima hora/dia", "intervalo medio entre 429", "em que modalidade/horario mais
//   acontece" e' respondida com GetItem/BatchGetItem O(1)/O(15)/O(24) sobre esses buckets, nunca
//   reprocessando o log bruto (getRateLimitSummary abaixo). Sem TTL -- cardinalidade e' pequena e
//   permanente (poucos milhares de itens por ano), vale reter pra tendencia de longo prazo.
// Duplicado de MODALIDADE_CODES (pncp-client.ts) de proposito: pncp-client importa este modulo pra
// registrar cada tentativa, entao importar de la de volta criaria dependencia circular.
const ALL_MODALIDADE_CODES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

export interface RateLimitAttemptEvent {
  modalidade: number;
  endpoint: string;
  attempt: number;
  httpStatus: number | null; // null = erro de rede, sem resposta HTTP
  is429: boolean;
  backoffDelayMs: number; // 0 quando a tentativa nao precisou de backoff (sucesso ou erro terminal)
}

interface GlobalRateLimitState {
  last429At?: string;
  streakStartedAt?: string;
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function yyyymmddhh(date: Date): string {
  return `${yyyymmdd(date)}${String(date.getUTCHours()).padStart(2, "0")}`;
}

async function readGlobalState(): Promise<GlobalRateLimitState> {
  const res = await ddbDocClient.send(
    new GetCommand({ TableName: METRICS_TABLE, Key: { metric_key: GLOBAL_STATE_KEY } }),
  );
  return {
    last429At: res.Item?.last_429_at as string | undefined,
    streakStartedAt: res.Item?.streak_started_at as string | undefined,
  };
}

async function bumpCounterBucket(metricKey: string, event: RateLimitAttemptEvent): Promise<void> {
  const isSuccess = !event.is429 && event.httpStatus !== null && event.httpStatus < 400;
  const isErrorNon429 = !event.is429 && (event.httpStatus === null || event.httpStatus >= 400);
  await ddbDocClient.send(
    new UpdateCommand({
      TableName: METRICS_TABLE,
      Key: { metric_key: metricKey },
      UpdateExpression:
        "ADD total_requests :one, total_429 :is429, total_success :isSuccess, total_error_non429 :isErrorNon429",
      ExpressionAttributeValues: {
        ":one": 1,
        ":is429": event.is429 ? 1 : 0,
        ":isSuccess": isSuccess ? 1 : 0,
        ":isErrorNon429": isErrorNon429 ? 1 : 0,
      },
    }),
  );
}

async function updateGlobalState(
  now: Date,
  event: RateLimitAttemptEvent,
  elapsedSincePrevious429Ms: number | null,
  timeToNormalizeMs: number | null,
): Promise<void> {
  const setParts: string[] = [];
  const removeParts: string[] = [];
  const addParts: string[] = [];
  const values: Record<string, unknown> = {};

  if (event.is429) {
    setParts.push("last_429_at = :now", "streak_started_at = if_not_exists(streak_started_at, :now)");
    values[":now"] = now.toISOString();
    if (elapsedSincePrevious429Ms !== null) {
      addParts.push("sum_interval_between_429_ms :interval", "count_429_intervals :one429");
      values[":interval"] = elapsedSincePrevious429Ms;
      values[":one429"] = 1;
    }
  } else if (timeToNormalizeMs !== null) {
    // sucesso apos um streak de 429 -- fecha o streak e mede quanto tempo levou pra normalizar.
    removeParts.push("streak_started_at");
    addParts.push("sum_time_to_normalize_ms :normalize", "count_normalize_events :onenorm");
    values[":normalize"] = timeToNormalizeMs;
    values[":onenorm"] = 1;
  } else {
    return; // sucesso sem streak anterior -- nao ha estado de rate-limit pra atualizar
  }

  const expressionParts: string[] = [];
  if (setParts.length) expressionParts.push(`SET ${setParts.join(", ")}`);
  if (removeParts.length) expressionParts.push(`REMOVE ${removeParts.join(", ")}`);
  if (addParts.length) expressionParts.push(`ADD ${addParts.join(", ")}`);

  await ddbDocClient.send(
    new UpdateCommand({
      TableName: METRICS_TABLE,
      Key: { metric_key: GLOBAL_STATE_KEY },
      UpdateExpression: expressionParts.join(" "),
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
    }),
  );
}

async function recordRateLimitAttemptUnsafe(event: RateLimitAttemptEvent): Promise<void> {
  const now = new Date();
  const iso = now.toISOString();

  const stateBefore = await readGlobalState();
  const previous429At = stateBefore.last429At ? new Date(stateBefore.last429At) : null;
  const elapsedSincePrevious429Ms = event.is429 && previous429At ? now.getTime() - previous429At.getTime() : null;

  let timeToNormalizeMs: number | null = null;
  if (!event.is429 && event.httpStatus !== null && event.httpStatus < 400 && stateBefore.streakStartedAt) {
    timeToNormalizeMs = now.getTime() - new Date(stateBefore.streakStartedAt).getTime();
  }

  const todayKey = yyyymmdd(now);
  await Promise.all([
    ddbDocClient.send(
      new PutCommand({
        TableName: EVENTS_TABLE,
        Item: {
          event_date: todayKey,
          sk: `${iso}#${String(event.modalidade).padStart(2, "0")}#${randomUUID().slice(0, 8)}`,
          timestamp: iso,
          modalidade: event.modalidade,
          endpoint: event.endpoint,
          attempt: event.attempt,
          http_status: event.httpStatus,
          is_429: event.is429,
          backoff_delay_ms: event.backoffDelayMs,
          elapsed_since_previous_429_ms: elapsedSincePrevious429Ms,
          time_to_normalize_ms: timeToNormalizeMs,
          ttl: Math.floor(now.getTime() / 1000) + EVENTS_TTL_DAYS * 24 * 3600,
        },
      }),
    ),
    bumpCounterBucket(`daily#${todayKey}`, event),
    bumpCounterBucket(`hourly#${yyyymmddhh(now)}`, event),
    bumpCounterBucket(`modalidade#${event.modalidade}#daily#${todayKey}`, event),
    updateGlobalState(now, event, elapsedSincePrevious429Ms, timeToNormalizeMs),
  ]);
}

/**
 * Registra uma tentativa de chamada ao PNCP (sucesso ou falha) para observabilidade empirica de
 * rate limiting. Nunca lanca -- uma falha ao gravar o evento de observabilidade nao pode derrubar
 * a ingestao real, que e' o que importa de verdade.
 */
export async function recordRateLimitAttempt(event: RateLimitAttemptEvent): Promise<void> {
  try {
    await recordRateLimitAttemptUnsafe(event);
  } catch (err) {
    console.error("[rate-limit-tracking] falha ao gravar evento (nao afeta a ingestao)", err);
  }
}

function last24HourKeys(now: Date): string[] {
  const keys: string[] = [];
  for (let i = 0; i < 24; i++) {
    keys.push(yyyymmddhh(new Date(now.getTime() - i * 3600 * 1000)));
  }
  return keys; // hora atual primeiro, mais antiga por ultimo
}

export interface RateLimitBucket {
  totalRequests: number;
  total429: number;
}

export interface RateLimitSummary {
  today: RateLimitBucket;
  last24Hours: RateLimitBucket;
  avgIntervalBetween429Ms: number | null;
  avgTimeToNormalizeMs: number | null;
  byModalidadeToday: Array<{ modalidade: number } & RateLimitBucket>;
  // serie das ultimas 24h, hora atual primeiro -- usada tanto pra display quanto pela deteccao de anomalia.
  last24HourSeries: Array<{ hour: string } & RateLimitBucket>;
  byHourToday: Array<{ hour: string } & RateLimitBucket>;
}

/**
 * Le as metricas agregadas de rate-limit tracking (item 2 desta rodada): responde "quantos 429 na
 * ultima hora/dia", "intervalo medio entre 429", "por modalidade/horario" sem nunca reprocessar
 * RateLimitEvents bruto -- so GetItem/BatchGetItem sobre os buckets pre-agregados.
 */
export async function getRateLimitSummary(): Promise<RateLimitSummary> {
  const now = new Date();
  const todayKey = yyyymmdd(now);
  const hourKeys = last24HourKeys(now);

  const [dailyRes, stateRes, modalidadeRes, hourlyRes] = await Promise.all([
    ddbDocClient.send(new GetCommand({ TableName: METRICS_TABLE, Key: { metric_key: `daily#${todayKey}` } })),
    ddbDocClient.send(new GetCommand({ TableName: METRICS_TABLE, Key: { metric_key: GLOBAL_STATE_KEY } })),
    ddbDocClient.send(
      new BatchGetCommand({
        RequestItems: {
          [METRICS_TABLE]: {
            Keys: ALL_MODALIDADE_CODES.map((m) => ({ metric_key: `modalidade#${m}#daily#${todayKey}` })),
          },
        },
      }),
    ),
    ddbDocClient.send(
      new BatchGetCommand({
        RequestItems: {
          [METRICS_TABLE]: { Keys: hourKeys.map((h) => ({ metric_key: `hourly#${h}` })) },
        },
      }),
    ),
  ]);

  const daily = dailyRes.Item ?? {};
  const state = stateRes.Item ?? {};
  const modalidadeItems = (modalidadeRes.Responses?.[METRICS_TABLE] ?? []) as Record<string, unknown>[];
  const hourlyItems = (hourlyRes.Responses?.[METRICS_TABLE] ?? []) as Record<string, unknown>[];

  const last24HourSeries = hourKeys.map((h) => {
    const item = hourlyItems.find((i) => i.metric_key === `hourly#${h}`);
    return {
      hour: h,
      totalRequests: Number(item?.total_requests ?? 0),
      total429: Number(item?.total_429 ?? 0),
    };
  });

  const last24Hours = last24HourSeries.reduce(
    (acc, h) => ({ totalRequests: acc.totalRequests + h.totalRequests, total429: acc.total429 + h.total429 }),
    { totalRequests: 0, total429: 0 },
  );

  const sumInterval = Number(state.sum_interval_between_429_ms ?? 0);
  const countInterval = Number(state.count_429_intervals ?? 0);
  const sumNormalize = Number(state.sum_time_to_normalize_ms ?? 0);
  const countNormalize = Number(state.count_normalize_events ?? 0);

  return {
    today: { totalRequests: Number(daily.total_requests ?? 0), total429: Number(daily.total_429 ?? 0) },
    last24Hours,
    avgIntervalBetween429Ms: countInterval > 0 ? Math.round(sumInterval / countInterval) : null,
    avgTimeToNormalizeMs: countNormalize > 0 ? Math.round(sumNormalize / countNormalize) : null,
    byModalidadeToday: ALL_MODALIDADE_CODES.map((m) => {
      const key = `modalidade#${m}#daily#${todayKey}`;
      const item = modalidadeItems.find((i) => i.metric_key === key);
      return {
        modalidade: m,
        totalRequests: Number(item?.total_requests ?? 0),
        total429: Number(item?.total_429 ?? 0),
      };
    }),
    last24HourSeries,
    byHourToday: last24HourSeries.filter((h) => h.hour.startsWith(todayKey)),
  };
}

const ANOMALY_MIN_429_COUNT = 5;
const ANOMALY_MULTIPLIER = 3;

/**
 * Heuristica simples de deteccao de mudanca de padrao (item 4 desta rodada): compara o total de
 * 429 da hora corrente contra a media das outras 23 horas na janela de 24h. Ainda nao ha baseline
 * historico de longo prazo (poucos dias de dado real coletado ate agora) -- suficiente pra
 * sinalizar picos obvios sem falso-positivo em volume baixo (piso de ANOMALY_MIN_429_COUNT).
 * Nunca lanca -- e' so log de observabilidade, roda no fim de cada job de ingestao/reconciliacao.
 */
export async function checkRateLimitAnomaly(): Promise<void> {
  try {
    const summary = await getRateLimitSummary();
    const [current, ...others] = summary.last24HourSeries;
    if (!current || others.length === 0) return;

    const othersAvg = others.reduce((s, h) => s + h.total429, 0) / others.length;

    if (current.total429 >= ANOMALY_MIN_429_COUNT && current.total429 >= othersAvg * ANOMALY_MULTIPLIER) {
      console.warn(
        `[rate-limit-tracking] ANOMALIA: hora ${current.hour} teve ${current.total429} respostas 429 ` +
          `(media das demais 23h da janela: ${othersAvg.toFixed(1)}) -- padrao de rate limit do PNCP pode ter mudado.`,
      );
    }
  } catch (err) {
    console.error("[rate-limit-tracking] falha ao checar anomalia (nao afeta a ingestao)", err);
  }
}
