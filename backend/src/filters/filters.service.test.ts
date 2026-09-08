import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

// Import depois dos mocks (hoisted pelo vitest).
import { SavedWebhookFilter } from "../webhook/filter.types";
import { createFilter, regenerateFilterSecret, updateOwnedFilter } from "./filters.service";

beforeEach(() => {
  sendMock.mockReset();
});

describe("createFilter", () => {
  it("persiste name=null quando nao informado", async () => {
    sendMock.mockResolvedValueOnce({});
    const filter = await createFilter("cust-1", { channel: "webhook", uf: "GO", modalidade: "Pregao", webhook_url: "https://x.com/hook" });
    expect(filter.name).toBeNull();
    expect((sendMock.mock.calls[0][0] as PutCommand).input.Item?.name).toBeNull();
  });

  it("persiste e faz trim do name quando informado", async () => {
    sendMock.mockResolvedValueOnce({});
    const filter = await createFilter("cust-1", {
      channel: "webhook",
      uf: "GO",
      modalidade: "Pregao",
      webhook_url: "https://x.com/hook",
      name: "  Meu alerta de TI  ",
    });
    expect(filter.name).toBe("Meu alerta de TI");
  });
});

describe("updateOwnedFilter", () => {
  const owned = {
    customer_id: "cust-1",
    filter_id: "filtro-1",
    name: "Antigo",
    uf: "GO",
    modalidade: "Pregao",
    channel: "webhook" as const,
    webhook_url: "https://old.com/hook",
    webhook_secret: "secret-1",
    active: true,
    consecutive_failures: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("atualiza name e webhook_url do proprio filtro", async () => {
    sendMock.mockResolvedValueOnce({ Item: owned }); // assertFilterOwnership
    sendMock.mockResolvedValueOnce({ Attributes: { ...owned, name: "Novo nome", webhook_url: "https://new.com/hook" } });

    const updated = await updateOwnedFilter("cust-1", "filtro-1", { name: "Novo nome", webhook_url: "https://new.com/hook" });

    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(sendMock.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
    expect(updated?.name).toBe("Novo nome");
    expect((updated as SavedWebhookFilter).webhook_url).toBe("https://new.com/hook");
  });

  it("retorna undefined (nao lanca) quando o filtro nao pertence ao cliente -- protecao IDOR", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined }); // GetItem com a chave composta nunca acha item de outro dono

    const result = await updateOwnedFilter("cust-1", "filtro-alheio", { name: "Tentativa" });

    expect(result).toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1); // nunca chega a escrever
  });
});

describe("regenerateFilterSecret", () => {
  const owned = {
    customer_id: "cust-1",
    filter_id: "filtro-1",
    name: null,
    uf: "GO",
    modalidade: "Pregao",
    webhook_url: "https://x.com/hook",
    webhook_secret: "secret-antigo",
    active: true,
    consecutive_failures: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("gera um webhook_secret NOVO (CSPRNG) e retorna true, sem nunca expor o secret", async () => {
    sendMock.mockResolvedValueOnce({ Item: owned }); // assertFilterOwnership
    sendMock.mockResolvedValueOnce({}); // UpdateCommand

    const ok = await regenerateFilterSecret("cust-1", "filtro-1");

    expect(ok).toBe(true);
    const updateInput = (sendMock.mock.calls[1][0] as UpdateCommand).input;
    const newSecret = updateInput.ExpressionAttributeValues?.[":secret"] as string;
    expect(newSecret).toHaveLength(64);
    expect(newSecret).not.toBe("secret-antigo");
  });

  it("retorna false (nao lanca) quando o filtro nao existe/nao pertence ao cliente", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });

    const ok = await regenerateFilterSecret("cust-1", "filtro-alheio");

    expect(ok).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
