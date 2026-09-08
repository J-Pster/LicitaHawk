import { beforeEach, describe, expect, it, vi } from "vitest";
import { SavedWebhookFilter } from "./filter.types";

const enqueueMock = vi.fn();
vi.mock("./alert-queue.instance", () => ({
  alertQueue: { enqueue: (...args: unknown[]) => enqueueMock(...args) },
}));

const incrementDailyUsageMock = vi.fn();
vi.mock("../common/usage-daily.repository", () => ({
  incrementDailyUsage: (...args: unknown[]) => incrementDailyUsageMock(...args),
}));

// Import depois dos mocks (hoisted pelo vitest).
import { dispatchTestWebhook } from "./webhook-test-dispatch";

function buildFilter(overrides: Partial<SavedWebhookFilter> = {}): SavedWebhookFilter {
  return {
    customer_id: "cust-1",
    filter_id: "filter-1",
    name: "Meu alerta",
    uf: "GO",
    modalidade: "Pregão - Eletrônico",
    keyword: undefined,
    channel: "webhook",
    webhook_url: "http://127.0.0.1:9999/hook",
    webhook_secret: "segredo",
    active: true,
    consecutive_failures: 0,
    created_at: "2026-09-07T00:00:00.000Z",
    updated_at: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  enqueueMock.mockReset();
  incrementDailyUsageMock.mockReset();
  enqueueMock.mockResolvedValue(undefined);
  incrementDailyUsageMock.mockResolvedValue(undefined);
});

describe("dispatchTestWebhook", () => {
  it("incrementa o uso diario como 'webhook' pro customer_id do filtro", async () => {
    const filter = buildFilter();

    await dispatchTestWebhook(filter);

    expect(incrementDailyUsageMock).toHaveBeenCalledWith("cust-1", "webhook");
  });

  it("enfileira o job de teste com o payload sintetico", async () => {
    const filter = buildFilter();

    await dispatchTestWebhook(filter);

    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filter_id: "filter-1",
        customer_id: "cust-1",
        target: { channel: "webhook", url: "http://127.0.0.1:9999/hook", secret: "segredo" },
      }),
    );
  });
});
