import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const verifyMock = vi.fn();
vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: {
    create: () => ({ verify: (...args: unknown[]) => verifyMock(...args) }),
  },
}));

// Import depois do mock (hoisted pelo vitest).
import { cognitoAuthenticate } from "./cognito-auth.middleware";

function buildReq(headers: Record<string, string | undefined> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    cognitoUser: undefined,
  } as unknown as Request;
}

function buildRes(): Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

beforeEach(() => {
  verifyMock.mockReset();
});

describe("cognitoAuthenticate", () => {
  it("responde 401 UNAUTHORIZED sem chamar o verifier quando nao ha header Authorization", async () => {
    const req = buildReq({});
    const res = buildRes();
    const next = vi.fn();

    await cognitoAuthenticate(req, res, next);

    expect(verifyMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "UNAUTHORIZED" }) }));
    expect(next).not.toHaveBeenCalled();
  });

  it("responde 401 quando o header nao comeca com 'Bearer '", async () => {
    const req = buildReq({ authorization: "chave-sem-bearer" });
    const res = buildRes();
    const next = vi.fn();

    await cognitoAuthenticate(req, res, next);

    expect(verifyMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("injeta req.cognitoUser = { sub, email } e chama next() quando o token e valido", async () => {
    verifyMock.mockResolvedValueOnce({ sub: "cognito-sub-123", email: "user@example.com", token_use: "id" });

    const req = buildReq({ authorization: "Bearer token-valido" });
    const res = buildRes();
    const next = vi.fn();

    await cognitoAuthenticate(req, res, next);

    expect(verifyMock).toHaveBeenCalledWith("token-valido");
    expect(req.cognitoUser).toEqual({ sub: "cognito-sub-123", email: "user@example.com" });
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("injeta email undefined quando o payload nao tem claim de email", async () => {
    verifyMock.mockResolvedValueOnce({ sub: "cognito-sub-456", token_use: "id" });

    const req = buildReq({ authorization: "Bearer token-sem-email" });
    const res = buildRes();
    const next = vi.fn();

    await cognitoAuthenticate(req, res, next);

    expect(req.cognitoUser).toEqual({ sub: "cognito-sub-456", email: undefined });
    expect(next).toHaveBeenCalledWith();
  });

  it("responde 401 UNAUTHORIZED quando o verifier rejeita (assinatura invalida, expirado, etc.)", async () => {
    verifyMock.mockRejectedValueOnce(new Error("token expirado"));

    const req = buildReq({ authorization: "Bearer token-expirado" });
    const res = buildRes();
    const next = vi.fn();

    await cognitoAuthenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "UNAUTHORIZED" }) }));
    expect(next).not.toHaveBeenCalled();
  });
});
