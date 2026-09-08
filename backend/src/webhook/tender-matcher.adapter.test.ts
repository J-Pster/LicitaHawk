import { beforeEach, describe, expect, it, vi } from "vitest";
import { Tender } from "../tenders/tender.types";
import { SavedWebhookFilter } from "./filter.types";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

const incrementDailyUsageMock = vi.fn();
vi.mock("../common/usage-daily.repository", () => ({
  incrementDailyUsage: (...args: unknown[]) => incrementDailyUsageMock(...args),
}));

// Import depois dos mocks (hoisted pelo vitest).
import { LocalTenderMatcherAdapter } from "./tender-matcher.adapter";

function buildFilter(overrides: Partial<SavedWebhookFilter> = {}): SavedWebhookFilter {
  return {
    customer_id: "cust-1",
    filter_id: "filter-1",
    name: null,
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

function buildTender(overrides: Partial<Tender> = {}): Tender {
  return {
    pncp_control_number: "1/2026",
    org_cnpj: "00000000000000",
    org_name: "Orgao X",
    uf: "GO",
    municipio: "Goiania",
    modalidade: "Pregão - Eletrônico",
    uf_modalidade: "GO#Pregão - Eletrônico",
    objeto: "objeto qualquer",
    valor_estimado: 100,
    data_publicacao: "2026-09-07T00:00:00.000Z",
    data_atualizacao: "2026-09-07T00:00:00.000Z",
    situacao: "Divulgada",
    link_pncp: "https://pncp.gov.br/x",
    keywords_tokenized: [],
    raw_payload: {},
    ...overrides,
  };
}

beforeEach(() => {
  sendMock.mockReset();
  incrementDailyUsageMock.mockReset();
  incrementDailyUsageMock.mockResolvedValue(undefined);
});

describe("LocalTenderMatcherAdapter.emit", () => {
  it("incrementa o uso diario como 'webhook' pro customer_id de cada filtro casado, antes de enfileirar", async () => {
    const filter = buildFilter();
    sendMock.mockResolvedValueOnce({ Items: [filter] });
    const enqueueMock = vi.fn().mockResolvedValue(undefined);
    const adapter = new LocalTenderMatcherAdapter({ enqueue: enqueueMock });

    await adapter.emit(buildTender());
    await Promise.resolve(); // deixa o enqueue fire-and-forget resolver

    expect(incrementDailyUsageMock).toHaveBeenCalledWith("cust-1", "webhook");
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ filter_id: "filter-1", customer_id: "cust-1" }));
  });

  it("nao incrementa nem enfileira quando o filtro esta inativo", async () => {
    sendMock.mockResolvedValueOnce({ Items: [buildFilter({ active: false })] });
    const enqueueMock = vi.fn().mockResolvedValue(undefined);
    const adapter = new LocalTenderMatcherAdapter({ enqueue: enqueueMock });

    await adapter.emit(buildTender());
    await Promise.resolve();

    expect(incrementDailyUsageMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("nao incrementa nem enfileira quando a keyword do filtro nao bate", async () => {
    sendMock.mockResolvedValueOnce({ Items: [buildFilter({ keyword: "palavra-que-nao-existe" })] });
    const enqueueMock = vi.fn().mockResolvedValue(undefined);
    const adapter = new LocalTenderMatcherAdapter({ enqueue: enqueueMock });

    await adapter.emit(buildTender());
    await Promise.resolve();

    expect(incrementDailyUsageMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("incrementa uma vez por filtro casado quando ha multiplos candidatos", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [buildFilter({ filter_id: "f1", customer_id: "cust-1" }), buildFilter({ filter_id: "f2", customer_id: "cust-2" })],
    });
    const enqueueMock = vi.fn().mockResolvedValue(undefined);
    const adapter = new LocalTenderMatcherAdapter({ enqueue: enqueueMock });

    await adapter.emit(buildTender());
    await Promise.resolve();

    expect(incrementDailyUsageMock).toHaveBeenCalledTimes(2);
    expect(incrementDailyUsageMock).toHaveBeenCalledWith("cust-1", "webhook");
    expect(incrementDailyUsageMock).toHaveBeenCalledWith("cust-2", "webhook");
  });
});
