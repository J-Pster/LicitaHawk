import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

const listAllPendingDeliveriesMock = vi.fn();
const removePendingDeliveryMock = vi.fn();
vi.mock("./webhook-delivery-queue.repository", () => ({
  listAllPendingDeliveries: (...args: unknown[]) => listAllPendingDeliveriesMock(...args),
  removePendingDelivery: (...args: unknown[]) => removePendingDeliveryMock(...args),
}));

const enqueueMock = vi.fn();
vi.mock("./alert-queue.instance", () => ({
  alertQueue: { enqueue: (...args: unknown[]) => enqueueMock(...args) },
}));

const opsAlertMock = vi.fn();
vi.mock("../common/ops-alert", () => ({
  opsAlert: (...args: unknown[]) => opsAlertMock(...args),
}));

import { recoverPendingWebhookDeliveries } from "./webhook-queue-recovery";

function pendingItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    delivery_id: "delivery-1",
    filter_id: "filter-1",
    customer_id: "cust-1",
    url: "https://example.com/hook",
    payload: { hello: "world" },
    idempotencyKey: "idem-1",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  sendMock.mockReset();
  listAllPendingDeliveriesMock.mockReset();
  removePendingDeliveryMock.mockReset();
  enqueueMock.mockReset();
  opsAlertMock.mockReset();
  removePendingDeliveryMock.mockResolvedValue(undefined);
  enqueueMock.mockResolvedValue(undefined);
});

describe("recoverPendingWebhookDeliveries", () => {
  it("nao faz nada (nao toca SavedFilters/enqueue) quando a fila durvel esta vazia -- caminho feliz, boot normal", async () => {
    listAllPendingDeliveriesMock.mockResolvedValueOnce([]);

    await recoverPendingWebhookDeliveries();

    expect(sendMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("re-enfileira o item orfao relendo o secret de SavedFilters, reusando o mesmo idempotencyKey e forcando attempt:1", async () => {
    listAllPendingDeliveriesMock.mockResolvedValueOnce([pendingItem()]);
    sendMock.mockResolvedValueOnce({
      Item: {
        filter_id: "filter-1",
        customer_id: "cust-1",
        webhook_url: "https://example.com/hook",
        webhook_secret: "segredo-real",
      },
    });

    await recoverPendingWebhookDeliveries();

    expect(enqueueMock).toHaveBeenCalledWith({
      filter_id: "filter-1",
      customer_id: "cust-1",
      target: { channel: "webhook", url: "https://example.com/hook", secret: "segredo-real" },
      payload: { hello: "world" },
      attempt: 1,
      idempotencyKey: "idem-1",
    });
  });

  it("REGRESSAO (nao duplicar na fila durvel): remove o registro orfao ANTES de re-enfileirar, nao depois", async () => {
    listAllPendingDeliveriesMock.mockResolvedValueOnce([pendingItem()]);
    sendMock.mockResolvedValueOnce({
      Item: { filter_id: "filter-1", customer_id: "cust-1", webhook_url: "https://example.com/hook", webhook_secret: "s" },
    });

    const callOrder: string[] = [];
    removePendingDeliveryMock.mockImplementation(async () => {
      callOrder.push("remove");
    });
    enqueueMock.mockImplementation(async () => {
      callOrder.push("enqueue");
    });

    await recoverPendingWebhookDeliveries();

    expect(callOrder).toEqual(["remove", "enqueue"]);
    expect(removePendingDeliveryMock).toHaveBeenCalledWith("delivery-1");
  });

  it("descarta a entrega orfa (remove sem re-enfileirar) quando o filtro ja foi deletado", async () => {
    listAllPendingDeliveriesMock.mockResolvedValueOnce([pendingItem()]);
    sendMock.mockResolvedValueOnce({ Item: undefined });

    await recoverPendingWebhookDeliveries();

    expect(removePendingDeliveryMock).toHaveBeenCalledWith("delivery-1");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("dispara ops-alert critical e retorna sem lancar quando o Scan da listagem falha", async () => {
    listAllPendingDeliveriesMock.mockRejectedValueOnce(new Error("scan indisponivel"));

    await expect(recoverPendingWebhookDeliveries()).resolves.toBeUndefined();

    expect(opsAlertMock).toHaveBeenCalledWith(
      "alert_queue_recovery_scan_failed",
      "critical",
      expect.objectContaining({ error: "scan indisponivel" }),
    );
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("processa cada item isoladamente: falha ao ler SavedFilters de um item nao impede os demais de serem recuperados", async () => {
    listAllPendingDeliveriesMock.mockResolvedValueOnce([
      pendingItem({ delivery_id: "delivery-1", filter_id: "filter-1" }),
      pendingItem({ delivery_id: "delivery-2", filter_id: "filter-2" }),
    ]);
    sendMock
      .mockRejectedValueOnce(new Error("dynamo timeout no item 1"))
      .mockResolvedValueOnce({
        Item: { filter_id: "filter-2", customer_id: "cust-1", webhook_url: "https://example.com/hook", webhook_secret: "s" },
      });

    await recoverPendingWebhookDeliveries();

    expect(opsAlertMock).toHaveBeenCalledWith(
      "alert_queue_recovery_item_failed",
      "warning",
      expect.objectContaining({ delivery_id: "delivery-1" }),
    );
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ filter_id: "filter-2" }));
  });

  it("nao lanca e dispara ops-alert warning quando o proprio enqueue (redisparo) falha -- fire-and-forget", async () => {
    listAllPendingDeliveriesMock.mockResolvedValueOnce([pendingItem()]);
    sendMock.mockResolvedValueOnce({
      Item: { filter_id: "filter-1", customer_id: "cust-1", webhook_url: "https://example.com/hook", webhook_secret: "s" },
    });
    enqueueMock.mockRejectedValueOnce(new Error("fila cheia"));

    await expect(recoverPendingWebhookDeliveries()).resolves.toBeUndefined();
    // Deixa o catch encadeado do enqueue (fire-and-forget) processar antes de checar.
    await new Promise((resolve) => setImmediate(resolve));

    expect(opsAlertMock).toHaveBeenCalledWith(
      "alert_queue_recovery_redeliver_failed",
      "warning",
      expect.objectContaining({ filter_id: "filter-1", delivery_id: "delivery-1" }),
    );
  });
});
