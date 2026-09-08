import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

const opsAlertMock = vi.fn();
vi.mock("../common/ops-alert", () => ({
  opsAlert: (...args: unknown[]) => opsAlertMock(...args),
}));

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  downgradeToFreeForAsaasCustomer,
  setPlanTierForAsaasCustomer,
  upgradePlanForAsaasCustomer,
} from "./customer-plan-sync";

beforeEach(() => {
  sendMock.mockReset();
  opsAlertMock.mockReset();
});

describe("setPlanTierForAsaasCustomer", () => {
  it("atualiza plan_tier via GSI quando o ApiKeyRecord existe e o tier mudou", async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [{ api_key_hash: "hash-1", customer_id: "cust-1", plan_tier: "free", active: true }] }) // Query GSI
      .mockResolvedValueOnce({}); // UpdateCommand

    const result = await setPlanTierForAsaasCustomer("cus_asaas_1", "pro");

    expect(result).toEqual({ updatedCount: 1, customerId: "cust-1", previousTier: "free" });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("[BUG REAL corrigido] atualiza TODAS as chaves ATIVAS do mesmo cliente (multiplas chaves nomeadas), nao so a primeira que a GSI devolver", async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: [
          { api_key_hash: "hash-antiga-revogada", customer_id: "cust-1", plan_tier: "free", active: false },
          { api_key_hash: "hash-a", customer_id: "cust-1", plan_tier: "free", active: true },
          { api_key_hash: "hash-b", customer_id: "cust-1", plan_tier: "free", active: true },
        ],
      })
      .mockResolvedValueOnce({}) // UpdateCommand hash-a
      .mockResolvedValueOnce({}); // UpdateCommand hash-b

    const result = await setPlanTierForAsaasCustomer("cus_asaas_1", "pro");

    expect(result).toEqual({ updatedCount: 2, customerId: "cust-1", previousTier: "free" });
    // 1 Query + 2 UpdateCommand (a chave revogada NUNCA e' atualizada)
    expect(sendMock).toHaveBeenCalledTimes(3);
    const updatedHashes = sendMock.mock.calls
      .slice(1)
      .map((call) => (call[0] as UpdateCommand).input.Key?.api_key_hash);
    expect(updatedHashes.sort()).toEqual(["hash-a", "hash-b"]);
  });

  it("e' idempotente: nao escreve nem loga de novo quando TODAS as chaves ativas ja estao no tier solicitado", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        { api_key_hash: "hash-a", customer_id: "cust-1", plan_tier: "pro", active: true },
        { api_key_hash: "hash-b", customer_id: "cust-1", plan_tier: "pro", active: true },
      ],
    });

    const result = await setPlanTierForAsaasCustomer("cus_asaas_1", "pro");

    expect(result).toEqual({ updatedCount: 0, customerId: "cust-1", previousTier: "pro" });
    expect(sendMock).toHaveBeenCalledTimes(1); // so a Query, nunca um UpdateCommand
  });

  it("atualiza so as chaves ativas que ainda estao desatualizadas quando ha divergencia entre elas", async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: [
          { api_key_hash: "hash-ja-pro", customer_id: "cust-1", plan_tier: "pro", active: true },
          { api_key_hash: "hash-ainda-free", customer_id: "cust-1", plan_tier: "free", active: true },
        ],
      })
      .mockResolvedValueOnce({}); // UpdateCommand so pra hash-ainda-free

    const result = await setPlanTierForAsaasCustomer("cus_asaas_1", "pro");

    expect(result.updatedCount).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect((sendMock.mock.calls[1][0] as UpdateCommand).input.Key?.api_key_hash).toBe("hash-ainda-free");
  });

  it("retorna updatedCount:0 e nao lanca quando nenhuma chave ATIVA esta vinculada (todas revogadas)", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ api_key_hash: "hash-revogada", customer_id: "cust-1", plan_tier: "pro", active: false }],
    });

    const result = await setPlanTierForAsaasCustomer("cus_asaas_1", "free");

    expect(result).toEqual({ updatedCount: 0, customerId: "cust-1" });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("retorna updatedCount:0 e nao lanca quando nenhum ApiKeyRecord esta vinculado ao asaas_customer_id (fluxo de signup ainda nao existe)", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });

    const result = await setPlanTierForAsaasCustomer("cus_orfao", "pro");

    expect(result).toEqual({ updatedCount: 0, customerId: undefined });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("propaga erro do DynamoDB sem engolir", async () => {
    sendMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(setPlanTierForAsaasCustomer("cus_1", "pro")).rejects.toThrow("timeout");
  });
});

describe("upgradePlanForAsaasCustomer", () => {
  it("retorna boolean simples repassando o resultado de setPlanTierForAsaasCustomer", async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [{ api_key_hash: "hash-1", customer_id: "cust-1", plan_tier: "free", active: true }] })
      .mockResolvedValueOnce({});

    await expect(upgradePlanForAsaasCustomer("cus_1", "starter")).resolves.toBe(true);
  });

  it("retorna false quando nenhuma chave e' de fato atualizada", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ api_key_hash: "hash-1", customer_id: "cust-1", plan_tier: "starter", active: true }],
    });

    await expect(upgradePlanForAsaasCustomer("cus_1", "starter")).resolves.toBe(false);
  });
});

describe("downgradeToFreeForAsaasCustomer", () => {
  it("rebaixa pra free e dispara ops-alert critical com o motivo quando o tier muda de fato", async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [{ api_key_hash: "hash-1", customer_id: "cust-1", plan_tier: "pro", active: true }] })
      .mockResolvedValueOnce({});

    const result = await downgradeToFreeForAsaasCustomer("cus_1", "PAYMENT_REFUNDED");

    expect(result).toEqual({ updatedCount: 1, customerId: "cust-1", previousTier: "pro" });
    expect(opsAlertMock).toHaveBeenCalledWith(
      "billing_plan_downgraded",
      "critical",
      expect.objectContaining({
        asaas_customer_id: "cus_1",
        customer_id: "cust-1",
        previous_tier: "pro",
        reason: "PAYMENT_REFUNDED",
      }),
    );
  });

  it("rebaixa TODAS as chaves ativas do cliente (multiplas chaves) num unico evento de estorno", async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: [
          { api_key_hash: "hash-a", customer_id: "cust-1", plan_tier: "pro", active: true },
          { api_key_hash: "hash-b", customer_id: "cust-1", plan_tier: "pro", active: true },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await downgradeToFreeForAsaasCustomer("cus_1", "PAYMENT_REFUNDED");

    expect(result.updatedCount).toBe(2);
    expect(opsAlertMock).toHaveBeenCalledTimes(1); // 1 alerta so, nao 1 por chave
  });

  it("REGRESSAO (idempotencia -- bug da Rodada 4): reenviar o mesmo evento de estorno duas vezes NAO dispara um segundo downgrade nem um segundo ops-alert", async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [{ api_key_hash: "hash-1", customer_id: "cust-1", plan_tier: "pro", active: true }] })
      .mockResolvedValueOnce({}); // 1o evento: downgrade real

    await downgradeToFreeForAsaasCustomer("cus_1", "PAYMENT_REFUNDED");
    expect(opsAlertMock).toHaveBeenCalledTimes(1);

    opsAlertMock.mockClear();
    sendMock.mockResolvedValueOnce({
      Items: [{ api_key_hash: "hash-1", customer_id: "cust-1", plan_tier: "free", active: true }],
    }); // 2o evento: ja esta free

    const secondResult = await downgradeToFreeForAsaasCustomer("cus_1", "PAYMENT_REFUNDED");

    expect(secondResult.updatedCount).toBe(0);
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it("nao dispara ops-alert quando nenhum ApiKeyRecord ativo esta vinculado", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });

    const result = await downgradeToFreeForAsaasCustomer("cus_orfao", "PAYMENT_DELETED");

    expect(result).toEqual({ updatedCount: 0, customerId: undefined });
    expect(opsAlertMock).not.toHaveBeenCalled();
  });
});
