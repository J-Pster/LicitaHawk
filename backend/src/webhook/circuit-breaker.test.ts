import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

const opsAlertMock = vi.fn();
vi.mock("../common/ops-alert", () => ({
  opsAlert: (...args: unknown[]) => opsAlertMock(...args),
}));

// Import depois dos mocks (hoisted pelo vitest, mas import fica explicito aqui por clareza).
import { recordFailure, recordSuccess, reactivateFilter, FilterNotDisabledError } from "./circuit-breaker";

function conditionalCheckFailed(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({ message: "conditional check failed", $metadata: {} });
}

beforeEach(() => {
  sendMock.mockReset();
  opsAlertMock.mockReset();
});

describe("recordFailure", () => {
  it("incrementa e retorna o novo contador sem desativar quando abaixo do limite", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { consecutive_failures: 3 } });

    const result = await recordFailure("cust-1", "filter-1", 5);

    expect(result).toBe(3);
    expect(sendMock).toHaveBeenCalledTimes(1); // so o ADD, sem chamar disableFilter
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it("desativa o filtro e dispara ops-alert quando atinge o limite de falhas consecutivas", async () => {
    sendMock
      .mockResolvedValueOnce({ Attributes: { consecutive_failures: 5 } }) // ADD consecutive_failures
      .mockResolvedValueOnce({}); // SET active=false

    const result = await recordFailure("cust-1", "filter-1", 5);

    expect(result).toBe(5);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(opsAlertMock).toHaveBeenCalledWith(
      "webhook_filter_circuit_breaker_open",
      "warning",
      expect.objectContaining({ filter_id: "filter-1", customer_id: "cust-1", consecutive_failures: 5 }),
    );
  });

  it("nao lanca e retorna 0 quando o filtro ja foi deletado (ConditionExpression falha)", async () => {
    sendMock.mockRejectedValueOnce(conditionalCheckFailed());

    const result = await recordFailure("cust-1", "filter-deletado", 5);

    expect(result).toBe(0);
  });

  it("nao duplica desativacao/alerta quando duas falhas concorrentes cruzam o limite ao mesmo tempo", async () => {
    sendMock
      .mockResolvedValueOnce({ Attributes: { consecutive_failures: 6 } }) // ADD
      .mockRejectedValueOnce(conditionalCheckFailed()); // SET active=false ja tinha sido feito por outra chamada

    const result = await recordFailure("cust-1", "filter-1", 5);

    expect(result).toBe(6);
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it("propaga erros inesperados do DynamoDB (nao engole silenciosamente)", async () => {
    sendMock.mockRejectedValueOnce(new Error("timeout de rede"));
    await expect(recordFailure("cust-1", "filter-1", 5)).rejects.toThrow("timeout de rede");
  });
});

describe("recordSuccess", () => {
  it("zera o contador de falhas consecutivas", async () => {
    sendMock.mockResolvedValueOnce({});
    await expect(recordSuccess("cust-1", "filter-1")).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("nao lanca quando o filtro ja foi deletado", async () => {
    sendMock.mockRejectedValueOnce(conditionalCheckFailed());
    await expect(recordSuccess("cust-1", "filter-deletado")).resolves.toBeUndefined();
  });
});

describe("reactivateFilter", () => {
  it("reativa com sucesso quando o filtro esta de fato desativado", async () => {
    sendMock.mockResolvedValueOnce({});
    await expect(reactivateFilter("cust-1", "filter-1")).resolves.toBeUndefined();
  });

  it("lanca FilterNotDisabledError quando o filtro ja esta ativo (ConditionExpression falha)", async () => {
    sendMock.mockRejectedValueOnce(conditionalCheckFailed());
    await expect(reactivateFilter("cust-1", "filter-ja-ativo")).rejects.toBeInstanceOf(
      FilterNotDisabledError,
    );
  });

  it("propaga erros inesperados do DynamoDB", async () => {
    sendMock.mockRejectedValueOnce(new Error("timeout de rede"));
    await expect(reactivateFilter("cust-1", "filter-1")).rejects.toThrow("timeout de rede");
  });
});
