import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "fixed-uuid-1",
}));

import { PutCommand, DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { listAllPendingDeliveries, persistPendingDelivery, removePendingDelivery } from "./webhook-delivery-queue.repository";
import { AlertDeliveryJob, TenderMatchedPayload } from "../common/ports/alert-queue-port";

beforeEach(() => {
  sendMock.mockReset();
});

const samplePayload: TenderMatchedPayload = {
  event: "tender.matched",
  filter_id: "filter-1",
  tender: {
    pncp_control_number: "1/2026",
    org_cnpj: "00000000000000",
    org_name: "Orgao X",
    uf: "GO",
    modalidade: "Pregao",
    objeto: "objeto qualquer",
    valor_estimado: 100,
    link_pncp: "https://pncp.gov.br/x",
  },
};

function sampleJob(): AlertDeliveryJob {
  return {
    filter_id: "filter-1",
    customer_id: "cust-1",
    target: { channel: "webhook", url: "https://example.com/hook", secret: "should-never-be-persisted" },
    payload: samplePayload,
    attempt: 1,
    idempotencyKey: "idem-1",
  };
}

describe("persistPendingDelivery", () => {
  it("grava o job na tabela WebhookDeliveryQueue e retorna o delivery_id gerado", async () => {
    sendMock.mockResolvedValueOnce({});

    const deliveryId = await persistPendingDelivery(sampleJob());

    expect(deliveryId).toBe("fixed-uuid-1");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0] as PutCommand;
    expect(command.input.TableName).toBe("WebhookDeliveryQueue");
    expect(command.input.Item).toMatchObject({
      delivery_id: "fixed-uuid-1",
      filter_id: "filter-1",
      customer_id: "cust-1",
      idempotencyKey: "idem-1",
    });
  });

  it("NUNCA persiste o alvo da entrega (url/secret) -- e' remontado do SavedFilter na recuperacao", async () => {
    sendMock.mockResolvedValueOnce({});

    await persistPendingDelivery(sampleJob());

    const command = sendMock.mock.calls[0][0] as PutCommand;
    expect(command.input.Item).not.toHaveProperty("secret");
    expect(command.input.Item).not.toHaveProperty("url");
    expect(command.input.Item).not.toHaveProperty("target");
    expect(JSON.stringify(command.input.Item)).not.toContain("should-never-be-persisted");
  });

  it("propaga erro do DynamoDB sem engolir (persistencia e' best-effort no chamador, nao aqui)", async () => {
    sendMock.mockRejectedValueOnce(new Error("dynamo indisponivel"));
    await expect(persistPendingDelivery(sampleJob())).rejects.toThrow("dynamo indisponivel");
  });
});

describe("removePendingDelivery", () => {
  it("remove o item pelo delivery_id", async () => {
    sendMock.mockResolvedValueOnce({});

    await removePendingDelivery("delivery-abc");

    const command = sendMock.mock.calls[0][0] as DeleteCommand;
    expect(command.input.TableName).toBe("WebhookDeliveryQueue");
    expect(command.input.Key).toEqual({ delivery_id: "delivery-abc" });
  });

  it("propaga erro do DynamoDB sem engolir", async () => {
    sendMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(removePendingDelivery("delivery-abc")).rejects.toThrow("timeout");
  });
});

describe("listAllPendingDeliveries", () => {
  it("retorna lista vazia quando a fila esta vazia (caminho feliz -- fila so tem item apos crash)", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });

    const result = await listAllPendingDeliveries();

    expect(result).toEqual([]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("pagina ate esgotar LastEvaluatedKey, acumulando itens de todas as paginas", async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: [{ delivery_id: "d1" }],
        LastEvaluatedKey: { delivery_id: "d1" },
      })
      .mockResolvedValueOnce({
        Items: [{ delivery_id: "d2" }],
        LastEvaluatedKey: undefined,
      });

    const result = await listAllPendingDeliveries();

    expect(result).toEqual([{ delivery_id: "d1" }, { delivery_id: "d2" }]);
    expect(sendMock).toHaveBeenCalledTimes(2);
    const secondCommand = sendMock.mock.calls[1][0] as ScanCommand;
    expect(secondCommand.input.ExclusiveStartKey).toEqual({ delivery_id: "d1" });
  });

  it("propaga erro do DynamoDB sem engolir (quem decide o que fazer e' o recovery, nao aqui)", async () => {
    sendMock.mockRejectedValueOnce(new Error("scan falhou"));
    await expect(listAllPendingDeliveries()).rejects.toThrow("scan falhou");
  });
});
