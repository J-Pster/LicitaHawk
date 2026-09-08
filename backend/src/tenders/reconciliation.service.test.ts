import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenderIngestedPort } from "../common/ports/tender-ingested-port";
import { Tender } from "./tender.types";

const ingestWindowMock = vi.fn();
vi.mock("./ingestion.service", () => ({
  ingestWindow: (...args: unknown[]) => ingestWindowMock(...args),
  formatYYYYMMDD: (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, ""),
}));

import { runReconciliation } from "./reconciliation.service";

function fakePort(): TenderIngestedPort {
  return { async emit(_tender: Tender) {} };
}

beforeEach(() => {
  ingestWindowMock.mockReset();
  ingestWindowMock.mockResolvedValue({ fetched: 0, written: 0, failedModalidades: [] });
});

describe("runReconciliation", () => {
  it("calcula uma janela de 30 dias (hoje - 30 ate hoje, formato YYYYMMDD) e delega para ingestWindow com o port recebido", async () => {
    const port = fakePort();
    await runReconciliation(port);

    expect(ingestWindowMock).toHaveBeenCalledTimes(1);
    const [dataInicial, dataFinal, calledPort] = ingestWindowMock.mock.calls[0];

    const today = new Date();
    const expectedFinal = today.toISOString().slice(0, 10).replace(/-/g, "");
    const expectedInicial = new Date(today.getTime() - 30 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");

    expect(dataFinal).toBe(expectedFinal);
    expect(dataInicial).toBe(expectedInicial);
    expect(calledPort).toBe(port);
  });

  it("retorna o resultado de ingestWindow sem transformacao (fetched/written/failedModalidades repassados)", async () => {
    ingestWindowMock.mockResolvedValue({ fetched: 42, written: 40, failedModalidades: [7] });

    const result = await runReconciliation(fakePort());

    expect(result).toEqual({ fetched: 42, written: 40, failedModalidades: [7] });
  });

  it("propaga rejeicao se ingestWindow lancar (reconciliacao nao engole erro silenciosamente -- quem chama, ex. scheduler.ts, decide o tratamento)", async () => {
    ingestWindowMock.mockRejectedValue(new Error("falha inesperada na janela"));

    await expect(runReconciliation(fakePort())).rejects.toThrow("falha inesperada na janela");
  });
});
