import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const sendMock = vi.fn();
vi.mock("./dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

const incrementAndCheckMonthlyUsageMock = vi.fn();
vi.mock("./auth/api-key.middleware", () => ({
  incrementAndCheckMonthlyUsage: (...args: unknown[]) => incrementAndCheckMonthlyUsageMock(...args),
}));

const incrementDailyUsageMock = vi.fn();
vi.mock("./usage-daily.repository", () => ({
  incrementDailyUsage: (...args: unknown[]) => incrementDailyUsageMock(...args),
}));

// Import depois dos mocks (hoisted pelo vitest).
import { clientRateLimit, enforceUsage, respondIfUsageExceeded, REQUESTS_PER_MINUTE } from "./client-rate-limit";

function buildReq(auth?: { customer_id: string; plan_tier: "free" | "starter" | "pro" }, path = "/v1/tenders"): Request {
  return { auth, path } as unknown as Request;
}

function buildRes(): Response & { setHeader: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response & { setHeader: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

beforeEach(() => {
  sendMock.mockReset();
  incrementAndCheckMonthlyUsageMock.mockReset();
  incrementAndCheckMonthlyUsageMock.mockResolvedValue({ requestCount: 1, limit: 5000, exceeded: false });
  incrementDailyUsageMock.mockReset();
});

describe("clientRateLimit", () => {
  it("chama next() direto sem tocar no DynamoDB quando req.auth esta ausente", async () => {
    const req = buildReq(undefined);
    const res = buildRes();
    const next = vi.fn();

    await clientRateLimit(req, res, next);

    expect(sendMock).not.toHaveBeenCalled();
    expect(incrementAndCheckMonthlyUsageMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("seta os headers X-RateLimit-Limit/Remaining e chama next() quando abaixo do limite por minuto", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 5 } });
    const req = buildReq({ customer_id: "cust-1", plan_tier: "starter" });
    const res = buildRes();
    const next = vi.fn();

    await clientRateLimit(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", String(REQUESTS_PER_MINUTE.starter));
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", String(REQUESTS_PER_MINUTE.starter - 5));
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("usa o limite por minuto correto por plano (free/starter/pro)", async () => {
    for (const plan of ["free", "starter", "pro"] as const) {
      sendMock.mockResolvedValueOnce({ Attributes: { request_count: 1 } });
      const req = buildReq({ customer_id: "cust-1", plan_tier: plan });
      const res = buildRes();
      const next = vi.fn();

      await clientRateLimit(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", String(REQUESTS_PER_MINUTE[plan]));
    }
  });

  it("responde 429 RATE_LIMITED ao estourar o limite por minuto, com Retry-After e Remaining=0", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 31 } }); // free: limite 30
    const req = buildReq({ customer_id: "cust-1", plan_tier: "free" });
    const res = buildRes();
    const next = vi.fn();

    await clientRateLimit(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", "0");
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "60");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "RATE_LIMITED" }) }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("[achado real Rodada 7] NAO consome quota mensal quando barrado pelo limite por minuto", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 31 } }); // free: limite 30, estourou
    const req = buildReq({ customer_id: "cust-1", plan_tier: "free" });
    const res = buildRes();
    const next = vi.fn();

    await clientRateLimit(req, res, next);

    // Antes da correcao, o incremento mensal rodava dentro de `authenticate`, ANTES do limite
    // por minuto ser checado -- uma requisicao rejeitada aqui ainda consumia UsageCounters.
    // Agora incrementAndCheckMonthlyUsage nunca deve ser chamado quando o limite por minuto
    // ja rejeitou a requisicao.
    expect(incrementAndCheckMonthlyUsageMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("consome quota mensal (chama incrementAndCheckMonthlyUsage) somente depois de passar no limite por minuto", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 1 } }); // bem abaixo do limite
    const req = buildReq({ customer_id: "cust-1", plan_tier: "pro" });
    const res = buildRes();
    const next = vi.fn();

    await clientRateLimit(req, res, next);

    expect(incrementAndCheckMonthlyUsageMock).toHaveBeenCalledWith("cust-1", "pro");
    expect(next).toHaveBeenCalledWith();
  });

  it("responde 429 PLAN_LIMIT_EXCEEDED quando passa no limite por minuto mas estoura o teto mensal", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 1 } }); // por minuto ok
    incrementAndCheckMonthlyUsageMock.mockResolvedValueOnce({ requestCount: 101, limit: 100, exceeded: true });
    const req = buildReq({ customer_id: "cust-1", plan_tier: "free" });
    const res = buildRes();
    const next = vi.fn();

    await clientRateLimit(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "3600");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: "PLAN_LIMIT_EXCEEDED", message: expect.stringContaining("100 requisicoes/mes") }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("chama next(err) sem lancar quando o DynamoDB falha na checagem por minuto (nao derruba o processo)", async () => {
    sendMock.mockRejectedValueOnce(new Error("timeout de rede"));
    const req = buildReq({ customer_id: "cust-1", plan_tier: "pro" });
    const res = buildRes();
    const next = vi.fn();

    await clientRateLimit(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.status).not.toHaveBeenCalled();
  });

  it("propaga (via next(err)) falha do incremento mensal sem derrubar o processo", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 1 } });
    incrementAndCheckMonthlyUsageMock.mockRejectedValueOnce(new Error("falha ao gravar UsageCounters"));
    const req = buildReq({ customer_id: "cust-1", plan_tier: "pro" });
    const res = buildRes();
    const next = vi.fn();

    await clientRateLimit(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it("incrementa o uso diario como 'api' pra rotas fora de /mcp", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 1 } });
    const req = buildReq({ customer_id: "cust-1", plan_tier: "pro" }, "/v1/tenders");
    const res = buildRes();
    const next = vi.fn();

    await clientRateLimit(req, res, next);

    expect(incrementDailyUsageMock).toHaveBeenCalledWith("cust-1", "api");
  });

  it("incrementa o uso diario como 'mcp' quando req.path e' '/mcp'", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 1 } });
    const req = buildReq({ customer_id: "cust-1", plan_tier: "pro" }, "/mcp");
    const res = buildRes();
    const next = vi.fn();

    await clientRateLimit(req, res, next);

    expect(incrementDailyUsageMock).toHaveBeenCalledWith("cust-1", "mcp");
  });

  it("NAO incrementa o uso diario quando barrado pelo limite por minuto (nunca passou do ponto do incremento mensal)", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 31 } }); // free: limite 30
    const req = buildReq({ customer_id: "cust-1", plan_tier: "free" });
    const res = buildRes();
    const next = vi.fn();

    await clientRateLimit(req, res, next);

    expect(incrementDailyUsageMock).not.toHaveBeenCalled();
  });

  it("grava a chave da janela no formato 'min#YYYYMMDDHHmm' via UpdateCommand", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 1 } });
    const req = buildReq({ customer_id: "cust-1", plan_tier: "pro" });
    const res = buildRes();
    const next = vi.fn();

    await clientRateLimit(req, res, next);

    const call = sendMock.mock.calls[0][0];
    expect(call.input.Key.customer_id).toBe("cust-1");
    expect(call.input.Key.window).toMatch(/^min#\d{12}$/);
  });
});

// enforceUsage/respondIfUsageExceeded (nucleo extraido do antigo clientRateLimit) -- reusados por
// src/account/account-playground.router.ts (enforceUsageForCognitoAccount) pra aplicar o MESMO
// limite/quota do plano em rotas autenticadas por Cognito, sem duplicar a logica acima.
describe("enforceUsage", () => {
  it("nao chama incrementAndCheckMonthlyUsage/incrementDailyUsage quando estoura o limite por minuto", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 31 } }); // free: limite 30

    const result = await enforceUsage("cust-1", "free", "api");

    expect(result).toEqual({ limit: REQUESTS_PER_MINUTE.free, count: 31, rateLimited: true });
    expect(incrementAndCheckMonthlyUsageMock).not.toHaveBeenCalled();
    expect(incrementDailyUsageMock).not.toHaveBeenCalled();
  });

  it("incrementa mensal/diario e devolve monthly quando passa no limite por minuto", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 1 } });
    incrementAndCheckMonthlyUsageMock.mockResolvedValueOnce({ requestCount: 1, limit: 5000, exceeded: false });

    const result = await enforceUsage("cust-1", "starter", "mcp");

    expect(incrementAndCheckMonthlyUsageMock).toHaveBeenCalledWith("cust-1", "starter");
    expect(incrementDailyUsageMock).toHaveBeenCalledWith("cust-1", "mcp");
    expect(result).toEqual({
      limit: REQUESTS_PER_MINUTE.starter,
      count: 1,
      rateLimited: false,
      monthly: { requestCount: 1, limit: 5000, exceeded: false },
    });
  });
});

describe("respondIfUsageExceeded", () => {
  function buildRes(): Response & { setHeader: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
    const res = {
      setHeader: vi.fn(),
      status: vi.fn(),
      json: vi.fn(),
    } as unknown as Response & { setHeader: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
    (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
    return res;
  }

  it("seta headers e devolve false (nao respondeu) quando dentro do limite", () => {
    const res = buildRes();

    const handled = respondIfUsageExceeded(
      res,
      { limit: 180, count: 5, rateLimited: false, monthly: { requestCount: 1, limit: 5000, exceeded: false } },
      "starter",
    );

    expect(handled).toBe(false);
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", "180");
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", "175");
    expect(res.status).not.toHaveBeenCalled();
  });

  it("responde 429 RATE_LIMITED e devolve true quando rateLimited", () => {
    const res = buildRes();

    const handled = respondIfUsageExceeded(res, { limit: 30, count: 31, rateLimited: true }, "free");

    expect(handled).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "60");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "RATE_LIMITED" }) }));
  });

  it("responde 429 PLAN_LIMIT_EXCEEDED e devolve true quando o mensal estourou", () => {
    const res = buildRes();

    const handled = respondIfUsageExceeded(
      res,
      { limit: 30, count: 1, rateLimited: false, monthly: { requestCount: 101, limit: 100, exceeded: true } },
      "free",
    );

    expect(handled).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "3600");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "PLAN_LIMIT_EXCEEDED", message: expect.stringContaining("100 requisicoes/mes") }) }),
    );
  });
});
