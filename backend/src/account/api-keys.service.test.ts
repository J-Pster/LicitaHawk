import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

// Import depois dos mocks (hoisted pelo vitest).
import { createApiKey, listApiKeys, parseExpiresAt, revokeApiKey, updateApiKey } from "./api-keys.service";

beforeEach(() => {
  sendMock.mockReset();
});

describe("parseExpiresAt", () => {
  it("aceita undefined/null como 'nunca expira' (null persistido)", () => {
    expect(parseExpiresAt(undefined)).toBeNull();
    expect(parseExpiresAt(null)).toBeNull();
  });

  it("aceita uma data ISO 8601 valida", () => {
    expect(parseExpiresAt("2027-01-01T00:00:00.000Z")).toBe("2027-01-01T00:00:00.000Z");
  });

  it("rejeita uma string que nao e' data valida", () => {
    expect(() => parseExpiresAt("nao-e-uma-data")).toThrowError(
      expect.objectContaining({ status: 400, code: "VALIDATION_ERROR" }),
    );
  });
});

describe("createApiKey", () => {
  it("cria uma chave NOVA (nao substitui as existentes), com plan_tier copiado da conta", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ api_key_hash: "hash-existente", customer_id: "cust-1", plan_tier: "pro", active: true, name: "Default", expires_at: null }],
    }); // findAccountByCustomerId
    sendMock.mockResolvedValueOnce({}); // putAccount

    const result = await createApiKey("cust-1", "Servidor de producao", null);

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0]).toBeInstanceOf(PutCommand);
    const item = (sendMock.mock.calls[1][0] as PutCommand).input.Item;
    expect(item?.plan_tier).toBe("pro");
    expect(item?.name).toBe("Servidor de producao");
    expect(item?.expires_at).toBeNull();
    expect(item?.api_key_hash).not.toBe("hash-existente"); // hash NOVO, nunca reusa
    expect(result.api_key).toHaveLength(64);
    expect(result.id).toBe(item?.api_key_hash);
  });

  it("lanca 404 ACCOUNT_NOT_PROVISIONED quando a conta nao existe", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    await expect(createApiKey("cust-sem-conta", "Nova chave", null)).rejects.toMatchObject({
      status: 404,
      code: "ACCOUNT_NOT_PROVISIONED",
    });
  });
});

describe("listApiKeys", () => {
  it("lista todas as chaves (ativas E revogadas) do cliente, ordenadas por created_at, sem expor api_key crua", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        { api_key_hash: "hash-b", customer_id: "cust-1", plan_tier: "pro", active: false, name: "Antiga", expires_at: null, created_at: "2026-01-01T00:00:00.000Z" },
        { api_key_hash: "hash-a", customer_id: "cust-1", plan_tier: "pro", active: true, name: "Producao", expires_at: "2027-01-01T00:00:00.000Z", created_at: "2026-06-01T00:00:00.000Z" },
      ],
    });

    const keys = await listApiKeys("cust-1");

    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(keys.map((k) => k.id)).toEqual(["hash-b", "hash-a"]); // mais antiga primeiro
    expect(keys.every((k) => !("api_key" in k))).toBe(true);
    expect(keys[1]).toEqual({ id: "hash-a", name: "Producao", created_at: "2026-06-01T00:00:00.000Z", expires_at: "2027-01-01T00:00:00.000Z", active: true });
  });

  it("retorna lista vazia quando o cliente nao tem nenhuma chave", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    await expect(listApiKeys("cust-sem-chaves")).resolves.toEqual([]);
  });
});

describe("updateApiKey", () => {
  it("renomeia e/ou muda expires_at de uma chave do proprio cliente", async () => {
    sendMock.mockResolvedValueOnce({
      Item: { api_key_hash: "hash-1", customer_id: "cust-1", plan_tier: "pro", active: true, name: "Antigo nome", expires_at: null, created_at: "2026-01-01T00:00:00.000Z" },
    }); // getAccountByApiKeyHash
    sendMock.mockResolvedValueOnce({}); // updateAccountFields

    const result = await updateApiKey("cust-1", "hash-1", { name: "Novo nome", expires_at: "2027-01-01T00:00:00.000Z" });

    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(sendMock.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
    expect(result.name).toBe("Novo nome");
    expect(result.expires_at).toBe("2027-01-01T00:00:00.000Z");
  });

  it("[protecao IDOR] lanca 404 quando a chave existe mas pertence a OUTRO customer_id", async () => {
    sendMock.mockResolvedValueOnce({
      Item: { api_key_hash: "hash-alheia", customer_id: "cust-outro", plan_tier: "pro", active: true, name: "X", expires_at: null, created_at: "2026-01-01T00:00:00.000Z" },
    });

    await expect(updateApiKey("cust-1", "hash-alheia", { name: "Tentativa de sequestro" })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(sendMock).toHaveBeenCalledTimes(1); // nunca chega a escrever
  });

  it("lanca 404 quando o hash nao existe", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });
    await expect(updateApiKey("cust-1", "hash-inexistente", { name: "X" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("revokeApiKey", () => {
  it("desativa (active:false) uma chave do proprio cliente", async () => {
    sendMock.mockResolvedValueOnce({
      Item: { api_key_hash: "hash-1", customer_id: "cust-1", plan_tier: "pro", active: true, name: "X", expires_at: null, created_at: "2026-01-01T00:00:00.000Z" },
    });
    sendMock.mockResolvedValueOnce({}); // deactivateApiKey (UpdateCommand)

    await revokeApiKey("cust-1", "hash-1");

    const updateCall = sendMock.mock.calls[1][0] as UpdateCommand;
    expect(updateCall).toBeInstanceOf(UpdateCommand);
    expect(updateCall.input.ExpressionAttributeValues).toMatchObject({ ":v0": false });
  });

  it("[protecao IDOR] lanca 404 sem revogar quando a chave pertence a outro customer_id", async () => {
    sendMock.mockResolvedValueOnce({
      Item: { api_key_hash: "hash-alheia", customer_id: "cust-outro", plan_tier: "pro", active: true, name: "X", expires_at: null, created_at: "2026-01-01T00:00:00.000Z" },
    });

    await expect(revokeApiKey("cust-1", "hash-alheia")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
