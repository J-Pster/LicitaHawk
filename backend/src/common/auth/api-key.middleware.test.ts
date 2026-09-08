import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import type { Request, Response } from "express";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const sendMock = vi.fn();
vi.mock("../dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

// Import depois dos mocks (hoisted pelo vitest).
import { authenticate, currentYyyymm, incrementAndCheckMonthlyUsage } from "./api-key.middleware";

function buildReq(headers: Record<string, string | undefined> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    auth: undefined,
  } as unknown as Request;
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
});

describe("authenticate", () => {
  it("responde 401 UNAUTHORIZED sem tocar no DynamoDB quando nenhuma API key e enviada", async () => {
    const req = buildReq({});
    const res = buildRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(sendMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "UNAUTHORIZED" }) }));
    expect(next).not.toHaveBeenCalled();
  });

  it("aceita a key via header 'Authorization: Bearer <key>'", async () => {
    const rawKey = "chave-teste-bearer";
    const hash = createHash("sha256").update(rawKey).digest("hex");
    sendMock.mockResolvedValueOnce({ Item: { api_key_hash: hash, customer_id: "cust-1", plan_tier: "pro", active: true } });

    const req = buildReq({ authorization: `Bearer ${rawKey}` });
    const res = buildRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(req.auth).toEqual({ customer_id: "cust-1", plan_tier: "pro" });
    expect(next).toHaveBeenCalledWith();
  });

  it("aceita a key via header 'X-Api-Key' quando Authorization esta ausente", async () => {
    const rawKey = "chave-teste-x-api-key";
    const hash = createHash("sha256").update(rawKey).digest("hex");
    sendMock.mockResolvedValueOnce({ Item: { api_key_hash: hash, customer_id: "cust-2", plan_tier: "starter", active: true } });

    const req = buildReq({ "x-api-key": rawKey });
    const res = buildRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(req.auth).toEqual({ customer_id: "cust-2", plan_tier: "starter" });
    expect(next).toHaveBeenCalledWith();
  });

  it("responde 401 UNAUTHORIZED quando a API key nao existe em ApiKeys", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });
    const req = buildReq({ authorization: "Bearer chave-inexistente" });
    const res = buildRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("responde 401 UNAUTHORIZED quando a API key existe mas esta desativada (active: false)", async () => {
    sendMock.mockResolvedValueOnce({ Item: { api_key_hash: "x", customer_id: "cust-3", plan_tier: "free", active: false } });
    const req = buildReq({ authorization: "Bearer chave-desativada" });
    const res = buildRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("responde 401 UNAUTHORIZED quando a API key existe, esta ativa, mas expires_at ja passou", async () => {
    sendMock.mockResolvedValueOnce({
      Item: { api_key_hash: "x", customer_id: "cust-5", plan_tier: "pro", active: true, expires_at: "2020-01-01T00:00:00.000Z" },
    });
    const req = buildReq({ authorization: "Bearer chave-expirada" });
    const res = buildRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "UNAUTHORIZED", message: expect.stringContaining("expirada") }) }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("aceita a key quando expires_at esta no futuro", async () => {
    sendMock.mockResolvedValueOnce({
      Item: { api_key_hash: "x", customer_id: "cust-6", plan_tier: "pro", active: true, expires_at: "2099-01-01T00:00:00.000Z" },
    });
    const req = buildReq({ authorization: "Bearer chave-nao-expirada" });
    const res = buildRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(req.auth).toEqual({ customer_id: "cust-6", plan_tier: "pro" });
    expect(next).toHaveBeenCalledWith();
  });

  it("aceita a key quando expires_at e' null (nunca expira)", async () => {
    sendMock.mockResolvedValueOnce({
      Item: { api_key_hash: "x", customer_id: "cust-7", plan_tier: "free", active: true, expires_at: null },
    });
    const req = buildReq({ authorization: "Bearer chave-sem-expiracao" });
    const res = buildRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it("[achado real Rodada 7] NAO incrementa UsageCounters -- so faz o GetCommand de identidade, nunca um 2o send (UpdateCommand)", async () => {
    const rawKey = "chave-valida";
    const hash = createHash("sha256").update(rawKey).digest("hex");
    sendMock.mockResolvedValueOnce({ Item: { api_key_hash: hash, customer_id: "cust-4", plan_tier: "pro", active: true } });

    const req = buildReq({ authorization: `Bearer ${rawKey}` });
    const res = buildRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    // Antes da correcao, authenticate fazia um 2o send() (UpdateCommand ADD em UsageCounters)
    // aqui mesmo, ANTES do limite por minuto (clientRateLimit) ser checado -- ver
    // incrementAndCheckMonthlyUsage/client-rate-limit.test.ts pro achado completo.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(next).toHaveBeenCalledWith();
  });

  it("chama next(err) sem lancar quando o DynamoDB falha (nao derruba o processo)", async () => {
    sendMock.mockRejectedValueOnce(new Error("timeout de rede"));
    const req = buildReq({ authorization: "Bearer chave-qualquer" });
    const res = buildRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("incrementAndCheckMonthlyUsage", () => {
  it("incrementa via UpdateCommand ADD (nunca get-then-put) e retorna exceeded=false abaixo do limite", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 42 } });

    const result = await incrementAndCheckMonthlyUsage("cust-1", "starter");

    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(UpdateCommand);
    const input = (sendMock.mock.calls[0][0] as UpdateCommand).input;
    expect(input.TableName).toBe("UsageCounters");
    expect(input.Key).toEqual({ customer_id: "cust-1", yyyymm: currentYyyymm() });
    expect(result).toEqual({ requestCount: 42, limit: 5000, exceeded: false });
  });

  it("retorna exceeded=true quando o contador ultrapassa o limite do plano", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 101 } }); // free: limite 100

    const result = await incrementAndCheckMonthlyUsage("cust-1", "free");

    expect(result).toEqual({ requestCount: 101, limit: 100, exceeded: true });
  });

  it("aplica o limite correto por plano (free=100, starter=5000, pro=50000)", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 1 } });
    expect((await incrementAndCheckMonthlyUsage("c", "free")).limit).toBe(100);

    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 1 } });
    expect((await incrementAndCheckMonthlyUsage("c", "starter")).limit).toBe(5000);

    sendMock.mockResolvedValueOnce({ Attributes: { request_count: 1 } });
    expect((await incrementAndCheckMonthlyUsage("c", "pro")).limit).toBe(50000);
  });

  it("propaga erro do DynamoDB (nao engole silenciosamente)", async () => {
    sendMock.mockRejectedValueOnce(new Error("timeout de rede"));
    await expect(incrementAndCheckMonthlyUsage("cust-1", "pro")).rejects.toThrow("timeout de rede");
  });
});
