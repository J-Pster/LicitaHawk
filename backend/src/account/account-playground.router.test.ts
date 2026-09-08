import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const findAccountByCustomerIdMock = vi.fn();
vi.mock("./account.repository", () => ({
  findAccountByCustomerId: (...args: unknown[]) => findAccountByCustomerIdMock(...args),
}));

const enforceUsageMock = vi.fn();
const respondIfUsageExceededMock = vi.fn();
vi.mock("../common/client-rate-limit", () => ({
  enforceUsage: (...args: unknown[]) => enforceUsageMock(...args),
  respondIfUsageExceeded: (...args: unknown[]) => respondIfUsageExceededMock(...args),
  // tenders.router.ts (de onde reusamos parseSearchQuery) tambem importa deste modulo pra sua
  // propria rota GET /v1/tenders -- precisa existir no mock, mesmo sem ser exercitado aqui.
  clientRateLimit: (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next(),
}));

const searchTendersMock = vi.fn();
const getTenderByIdMock = vi.fn();
const findRecentlyUpdatedMatchesMock = vi.fn();
vi.mock("../tenders/tenders.service", () => ({
  searchTenders: (...args: unknown[]) => searchTendersMock(...args),
  getTenderById: (...args: unknown[]) => getTenderByIdMock(...args),
  findRecentlyUpdatedMatches: (...args: unknown[]) => findRecentlyUpdatedMatchesMock(...args),
}));

// Import depois dos mocks (hoisted pelo vitest).
import { accountPlaygroundRouter, enforceUsageForCognitoAccount } from "./account-playground.router";

function buildReq(overrides: Partial<Request> = {}): Request {
  return { cognitoUser: { sub: "cognito-sub-1" }, query: {}, params: {}, ...overrides } as unknown as Request;
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

/** Executa um handler registrado no router por METODO+PATH exato (sem casar params dinamicos --
 * usado so pra achar a rota certa nos testes, o parse de :id em si e' feito pelo Express de verdade). */
function findLayer(method: string, path: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (accountPlaygroundRouter as any).stack as any[];
  const layer = stack.find((l) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer) throw new Error(`rota nao encontrada: ${method.toUpperCase()} ${path}`);
  return layer.route.stack as { handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }[];
}

/**
 * asyncHandler (src/common/async-handler.ts) faz `fn(req, res, next).catch(next)` sem RETORNAR a
 * promise interna -- entao um simples `await finalHandler(...)` nao espera o corpo async da rota
 * terminar. Resolve explicitamente quando `res.json` e' chamado (caminho de sucesso) ou quando
 * `next(err)` e' chamado (caminho de erro), o que vier primeiro.
 */
async function runRoute(method: string, path: string, req: Request, res: Response & { json: ReturnType<typeof vi.fn> }) {
  const handlers = findLayer(method, path);
  // Pula o 1o (cognitoAuthenticate) e o 2o (enforceUsageForCognitoAccount) -- testados isolados
  // acima; aqui exercitamos so o handler final da rota (asyncHandler(...)).
  const finalHandler = handlers[handlers.length - 1].handle;

  return new Promise((resolve, reject) => {
    res.json.mockImplementation(() => {
      resolve(undefined);
      return res;
    });

    finalHandler(req, res, (err?: unknown) => {
      if (err) reject(err);
    });
  });
}

beforeEach(() => {
  findAccountByCustomerIdMock.mockReset();
  enforceUsageMock.mockReset();
  respondIfUsageExceededMock.mockReset();
  respondIfUsageExceededMock.mockReturnValue(false);
  searchTendersMock.mockReset();
  getTenderByIdMock.mockReset();
  findRecentlyUpdatedMatchesMock.mockReset();
});

describe("enforceUsageForCognitoAccount", () => {
  it("404 ACCOUNT_NOT_PROVISIONED quando a conta nao existe, sem chamar enforceUsage", async () => {
    findAccountByCustomerIdMock.mockResolvedValueOnce(undefined);
    const req = buildReq();
    const res = buildRes();
    const next = vi.fn();

    await enforceUsageForCognitoAccount(req, res, next);

    expect(enforceUsageMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404, code: "ACCOUNT_NOT_PROVISIONED" }));
  });

  it("chama enforceUsage com o plan_tier da conta e surface 'ui', chama next() quando nao excedido", async () => {
    findAccountByCustomerIdMock.mockResolvedValueOnce({ customer_id: "cognito-sub-1", plan_tier: "starter" });
    enforceUsageMock.mockResolvedValueOnce({ limit: 180, count: 1, rateLimited: false, monthly: { requestCount: 1, limit: 5000, exceeded: false } });
    respondIfUsageExceededMock.mockReturnValueOnce(false);
    const req = buildReq();
    const res = buildRes();
    const next = vi.fn();

    await enforceUsageForCognitoAccount(req, res, next);

    expect(enforceUsageMock).toHaveBeenCalledWith("cognito-sub-1", "starter", "ui");
    expect(next).toHaveBeenCalledWith();
  });

  it("nao chama next() quando respondIfUsageExceeded ja enviou a resposta (429)", async () => {
    findAccountByCustomerIdMock.mockResolvedValueOnce({ customer_id: "cognito-sub-1", plan_tier: "free" });
    enforceUsageMock.mockResolvedValueOnce({ limit: 30, count: 31, rateLimited: true });
    respondIfUsageExceededMock.mockReturnValueOnce(true);
    const req = buildReq();
    const res = buildRes();
    const next = vi.fn();

    await enforceUsageForCognitoAccount(req, res, next);

    expect(next).not.toHaveBeenCalled();
  });

  it("propaga (via next(err)) falha inesperada sem lancar", async () => {
    findAccountByCustomerIdMock.mockRejectedValueOnce(new Error("timeout de rede"));
    const req = buildReq();
    const res = buildRes();
    const next = vi.fn();

    await enforceUsageForCognitoAccount(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("GET /v1/account/playground/tenders", () => {
  it("valida modalidade contra o dominio oficial (400 VALIDATION_ERROR) antes de chamar searchTenders", async () => {
    const req = buildReq({ query: { uf: "GO", modalidade: "modalidade-invalida" } });
    const res = buildRes();

    await expect(runRoute("get", "/v1/account/playground/tenders", req, res)).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    expect(searchTendersMock).not.toHaveBeenCalled();
  });

  it("reusa parseSearchQuery/searchTenders e devolve o mesmo formato de GET /v1/tenders", async () => {
    searchTendersMock.mockResolvedValueOnce({ data: [{ pncp_control_number: "1" }], next_cursor: "abc" });
    const req = buildReq({ query: { uf: "GO", modalidade: "Pregão - Eletrônico", keyword: "informatica" } });
    const res = buildRes();

    await runRoute("get", "/v1/account/playground/tenders", req, res);

    expect(searchTendersMock).toHaveBeenCalledWith(
      expect.objectContaining({ uf: ["GO"], modalidade: ["Pregão - Eletrônico"], keyword: "informatica" }),
    );
    expect(res.json).toHaveBeenCalledWith({ data: [{ pncp_control_number: "1" }], next_cursor: "abc" });
  });
});

describe("GET /v1/account/playground/tenders/:id", () => {
  it("404 NOT_FOUND quando o tender nao existe", async () => {
    getTenderByIdMock.mockResolvedValueOnce(undefined);
    const req = buildReq({ params: { id: "inexistente" } });
    const res = buildRes();

    await expect(runRoute("get", "/v1/account/playground/tenders/:id", req, res)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("devolve o tender COMPLETO (com detail), mesmo shape de GET /v1/tenders/:id", async () => {
    // O numero de controle nao segue o padrao do PNCP de proposito: assim getFullTender devolve o
    // tender indexado com detail nulo, sem tocar na rede, e o teste segue sem mockar o PNCP.
    getTenderByIdMock.mockResolvedValueOnce({ pncp_control_number: "1", uf: "GO" });
    const req = buildReq({ params: { id: "1" } });
    const res = buildRes();

    await runRoute("get", "/v1/account/playground/tenders/:id", req, res);

    expect(res.json).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pncp_control_number: "1",
        uf: "GO",
        detail: null,
        detail_error: expect.stringContaining("fora do padrao"),
      }),
    });
  });
});

describe("GET /v1/account/playground/webhook-preview", () => {
  it("400 VALIDATION_ERROR quando uf ou modalidade ausentes", async () => {
    const req = buildReq({ query: { uf: "GO" } });
    const res = buildRes();

    await expect(runRoute("get", "/v1/account/playground/webhook-preview", req, res)).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    expect(findRecentlyUpdatedMatchesMock).not.toHaveBeenCalled();
  });

  it("400 VALIDATION_ERROR quando modalidade nao bate com o dominio oficial", async () => {
    const req = buildReq({ query: { uf: "GO", modalidade: "modalidade-qualquer" } });
    const res = buildRes();

    await expect(runRoute("get", "/v1/account/playground/webhook-preview", req, res)).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("400 VALIDATION_ERROR quando 'since' nao e' uma data ISO valida", async () => {
    const req = buildReq({ query: { uf: "GO", modalidade: "Pregão - Eletrônico", since: "data-invalida" } });
    const res = buildRes();

    await expect(runRoute("get", "/v1/account/playground/webhook-preview", req, res)).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("chama findRecentlyUpdatedMatches com uf maiusculo/modalidade/keyword/since e devolve { tenders, since }", async () => {
    findRecentlyUpdatedMatchesMock.mockResolvedValueOnce({
      tenders: [{ pncp_control_number: "1", data_atualizacao: "2026-09-07T10:00:00.000Z" }],
      since: "2026-09-07T10:00:00.000Z",
    });
    const req = buildReq({
      query: { uf: "go", modalidade: "Pregão - Eletrônico", keyword: "informatica", since: "2026-09-01T00:00:00.000Z" },
    });
    const res = buildRes();

    await runRoute("get", "/v1/account/playground/webhook-preview", req, res);

    expect(findRecentlyUpdatedMatchesMock).toHaveBeenCalledWith({
      uf: "GO",
      modalidade: "Pregão - Eletrônico",
      keyword: "informatica",
      since: "2026-09-01T00:00:00.000Z",
    });
    expect(res.json).toHaveBeenCalledWith({
      data: { tenders: [{ pncp_control_number: "1", data_atualizacao: "2026-09-07T10:00:00.000Z" }], since: "2026-09-07T10:00:00.000Z" },
    });
  });

  it("aceita chamada sem 'since' (primeira checagem do frontend)", async () => {
    findRecentlyUpdatedMatchesMock.mockResolvedValueOnce({ tenders: [], since: undefined });
    const req = buildReq({ query: { uf: "GO", modalidade: "Pregão - Eletrônico" } });
    const res = buildRes();

    await runRoute("get", "/v1/account/playground/webhook-preview", req, res);

    expect(findRecentlyUpdatedMatchesMock).toHaveBeenCalledWith({
      uf: "GO",
      modalidade: "Pregão - Eletrônico",
      keyword: undefined,
      since: undefined,
    });
  });
});
