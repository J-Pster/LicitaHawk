import { beforeEach, describe, expect, it, vi } from "vitest";
import { BatchGetCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

import { checkRateLimitAnomaly, getRateLimitSummary, recordRateLimitAttempt } from "./rate-limit-tracking";

function baseEvent(overrides: Partial<Parameters<typeof recordRateLimitAttempt>[0]> = {}) {
  return {
    attempt: 1,
    modalidade: 1,
    endpoint: "https://pncp.gov.br/api/consulta/v1/contratacoes/atualizacao?x",
    httpStatus: 200,
    is429: false,
    backoffDelayMs: 0,
    ...overrides,
  };
}

beforeEach(() => {
  sendMock.mockReset();
  vi.restoreAllMocks();
});

describe("recordRateLimitAttempt -- garantia de design (Rodada 1): nunca lanca", () => {
  it("resolve sem lancar mesmo quando TODA chamada ao DynamoDB rejeita (indisponibilidade total)", async () => {
    sendMock.mockRejectedValue(new Error("DynamoDB indisponivel"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recordRateLimitAttempt(baseEvent())).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "[rate-limit-tracking] falha ao gravar evento (nao afeta a ingestao)",
      expect.any(Error),
    );
  });

  it("resolve sem lancar quando so a leitura do estado global (GetCommand) falha, mas as escritas funcionariam", async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand) return Promise.reject(new Error("timeout na leitura"));
      return Promise.resolve({});
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recordRateLimitAttempt(baseEvent({ is429: true, httpStatus: 429 }))).resolves.toBeUndefined();
  });

  it("resolve sem lancar quando so a gravacao do evento bruto (PutCommand) falha", async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof PutCommand) return Promise.reject(new Error("condicao de throughput excedida"));
      return Promise.resolve({});
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recordRateLimitAttempt(baseEvent())).resolves.toBeUndefined();
  });
});

describe("checkRateLimitAnomaly -- nunca lanca (so observabilidade, roda ao fim de toda janela de ingestao)", () => {
  it("resolve sem lancar quando o DynamoDB esta indisponivel (getRateLimitSummary rejeita)", async () => {
    sendMock.mockRejectedValue(new Error("DynamoDB indisponivel"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(checkRateLimitAnomaly()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "[rate-limit-tracking] falha ao checar anomalia (nao afeta a ingestao)",
      expect.any(Error),
    );
  });
});

/** Constroi um mock de sendMock que responde de forma diferenciada por tipo/forma de comando. */
function makeSummaryMock(opts: {
  dailyTotal?: { total_requests: number; total_429: number };
  state?: Record<string, unknown>;
  hourlyByIndex?: Record<number, { total_requests: number; total_429: number }>;
}) {
  return (cmd: unknown) => {
    if (cmd instanceof GetCommand) {
      const key = (cmd as GetCommand).input.Key?.metric_key as string;
      if (key === "state#global") return Promise.resolve({ Item: opts.state });
      if (key?.startsWith("daily#")) return Promise.resolve({ Item: opts.dailyTotal });
      return Promise.resolve({});
    }
    if (cmd instanceof BatchGetCommand) {
      const keys = (cmd as BatchGetCommand).input.RequestItems!.RateLimitMetrics.Keys as Array<{
        metric_key: string;
      }>;
      // batch de horario tem 24 chaves (ultimas 24h); batch de modalidade tem 15 (ALL_MODALIDADE_CODES).
      if (keys.length === 24) {
        const responses = keys
          .map((k, i) => {
            const bucket = opts.hourlyByIndex?.[i];
            return bucket ? { metric_key: k.metric_key, total_requests: bucket.total_requests, total_429: bucket.total_429 } : null;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
        return Promise.resolve({ Responses: { RateLimitMetrics: responses } });
      }
      return Promise.resolve({ Responses: { RateLimitMetrics: [] } });
    }
    return Promise.resolve({});
  };
}

describe("getRateLimitSummary -- agregacao sobre buckets pre-computados", () => {
  it("retorna estrutura zerada/nula quando nao ha nenhum dado gravado ainda (projeto recem-instalado)", async () => {
    sendMock.mockImplementation(makeSummaryMock({}));

    const summary = await getRateLimitSummary();

    expect(summary.today).toEqual({ totalRequests: 0, total429: 0 });
    expect(summary.last24Hours).toEqual({ totalRequests: 0, total429: 0 });
    expect(summary.avgIntervalBetween429Ms).toBeNull();
    expect(summary.avgTimeToNormalizeMs).toBeNull();
    expect(summary.byModalidadeToday).toHaveLength(15);
    expect(summary.byModalidadeToday.every((m) => m.totalRequests === 0 && m.total429 === 0)).toBe(true);
    expect(summary.last24HourSeries).toHaveLength(24);
  });

  it("soma corretamente last24Hours a partir da serie horaria e calcula as medias do estado global", async () => {
    sendMock.mockImplementation(
      makeSummaryMock({
        dailyTotal: { total_requests: 100, total_429: 7 },
        state: {
          sum_interval_between_429_ms: 60_000,
          count_429_intervals: 3, // media = 20000ms
          sum_time_to_normalize_ms: 90_000,
          count_normalize_events: 2, // media = 45000ms
        },
        hourlyByIndex: {
          0: { total_requests: 10, total_429: 2 },
          1: { total_requests: 5, total_429: 1 },
          23: { total_requests: 1, total_429: 0 },
        },
      }),
    );

    const summary = await getRateLimitSummary();

    expect(summary.today).toEqual({ totalRequests: 100, total429: 7 });
    expect(summary.last24Hours).toEqual({ totalRequests: 16, total429: 3 });
    expect(summary.avgIntervalBetween429Ms).toBe(20_000);
    expect(summary.avgTimeToNormalizeMs).toBe(45_000);
  });
});

describe("checkRateLimitAnomaly -- heuristica de deteccao de pico", () => {
  it("dispara console.warn quando a hora atual tem >= 5 respostas 429 E >= 3x a media das outras 23h", async () => {
    sendMock.mockImplementation(
      makeSummaryMock({
        hourlyByIndex: { 0: { total_requests: 20, total_429: 10 } }, // demais horas ficam 0 -> media=0
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await checkRateLimitAnomaly();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("ANOMALIA");
  });

  it("NAO dispara quando o total de 429 da hora atual fica abaixo do piso minimo (ANOMALY_MIN_429_COUNT=5)", async () => {
    sendMock.mockImplementation(makeSummaryMock({ hourlyByIndex: { 0: { total_requests: 5, total_429: 4 } } }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await checkRateLimitAnomaly();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("NAO dispara quando o pico atual nao chega a 3x a media das outras 23h (mesmo acima do piso)", async () => {
    sendMock.mockImplementation(
      makeSummaryMock({
        hourlyByIndex: {
          0: { total_requests: 20, total_429: 6 }, // hora atual: 6
          1: { total_requests: 20, total_429: 3 }, // outras 23h somam 69 -> media = 3 -> limiar = 9
          2: { total_requests: 20, total_429: 3 },
          3: { total_requests: 20, total_429: 3 },
          4: { total_requests: 20, total_429: 3 },
          5: { total_requests: 20, total_429: 3 },
          6: { total_requests: 20, total_429: 3 },
          7: { total_requests: 20, total_429: 3 },
          8: { total_requests: 20, total_429: 3 },
          9: { total_requests: 20, total_429: 3 },
          10: { total_requests: 20, total_429: 3 },
          11: { total_requests: 20, total_429: 3 },
          12: { total_requests: 20, total_429: 3 },
          13: { total_requests: 20, total_429: 3 },
          14: { total_requests: 20, total_429: 3 },
          15: { total_requests: 20, total_429: 3 },
          16: { total_requests: 20, total_429: 3 },
          17: { total_requests: 20, total_429: 3 },
          18: { total_requests: 20, total_429: 3 },
          19: { total_requests: 20, total_429: 3 },
          20: { total_requests: 20, total_429: 3 },
          21: { total_requests: 20, total_429: 3 },
          22: { total_requests: 20, total_429: 3 },
          23: { total_requests: 20, total_429: 3 },
        },
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await checkRateLimitAnomaly();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("recordRateLimitAttempt -- construcao do estado global (streak de 429)", () => {
  function findGlobalStateUpdate(): UpdateCommand {
    const call = sendMock.mock.calls.find(
      ([cmd]) => cmd instanceof UpdateCommand && (cmd as UpdateCommand).input.Key?.metric_key === "state#global",
    );
    if (!call) throw new Error("nenhum UpdateCommand para state#global foi enviado");
    return call[0] as UpdateCommand;
  }

  it("no primeiro 429 (sem streak anterior), marca last_429_at e inicia streak_started_at, sem somar intervalo", async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand && (cmd as GetCommand).input.Key?.metric_key === "state#global") {
        return Promise.resolve({}); // sem estado anterior
      }
      return Promise.resolve({});
    });

    await recordRateLimitAttempt(baseEvent({ is429: true, httpStatus: 429 }));

    const update = findGlobalStateUpdate();
    expect(update.input.UpdateExpression).toContain("SET last_429_at");
    expect(update.input.UpdateExpression).toContain("streak_started_at = if_not_exists(streak_started_at, :now)");
    expect(update.input.UpdateExpression).not.toContain("sum_interval_between_429_ms");
  });

  it("num 429 subsequente (com streak em andamento), acumula o intervalo desde o 429 anterior", async () => {
    const previous429At = new Date(Date.now() - 5_000).toISOString();
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand && (cmd as GetCommand).input.Key?.metric_key === "state#global") {
        return Promise.resolve({ Item: { last_429_at: previous429At, streak_started_at: previous429At } });
      }
      return Promise.resolve({});
    });

    await recordRateLimitAttempt(baseEvent({ is429: true, httpStatus: 429 }));

    const update = findGlobalStateUpdate();
    expect(update.input.UpdateExpression).toContain("ADD sum_interval_between_429_ms :interval, count_429_intervals :one429");
    expect(update.input.ExpressionAttributeValues![":interval"] as number).toBeGreaterThanOrEqual(5_000);
  });

  it("num sucesso apos um streak de 429, fecha o streak e soma o tempo-ate-normalizar", async () => {
    const streakStartedAt = new Date(Date.now() - 10_000).toISOString();
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand && (cmd as GetCommand).input.Key?.metric_key === "state#global") {
        return Promise.resolve({ Item: { last_429_at: streakStartedAt, streak_started_at: streakStartedAt } });
      }
      return Promise.resolve({});
    });

    await recordRateLimitAttempt(baseEvent({ is429: false, httpStatus: 200 }));

    const update = findGlobalStateUpdate();
    expect(update.input.UpdateExpression).toContain("REMOVE streak_started_at");
    expect(update.input.UpdateExpression).toContain("ADD sum_time_to_normalize_ms :normalize, count_normalize_events :onenorm");
  });

  it("num sucesso sem nenhum streak anterior, nao envia UpdateCommand nenhum para o estado global", async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand && (cmd as GetCommand).input.Key?.metric_key === "state#global") {
        return Promise.resolve({}); // sem estado anterior
      }
      return Promise.resolve({});
    });

    await recordRateLimitAttempt(baseEvent({ is429: false, httpStatus: 200 }));

    const globalUpdateCall = sendMock.mock.calls.find(
      ([cmd]) => cmd instanceof UpdateCommand && (cmd as UpdateCommand).input.Key?.metric_key === "state#global",
    );
    expect(globalUpdateCall).toBeUndefined();
  });
});
