import { beforeEach, describe, expect, it, vi } from "vitest";
import { BatchWriteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Tender } from "./tender.types";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

const fetchPageMock = vi.fn();
const normalizeTenderMock = vi.fn();
vi.mock("./pncp-client", () => ({
  MODALIDADE_CODES: [1, 2],
  fetchContratacoesAtualizacaoPage: (...args: unknown[]) => fetchPageMock(...args),
  normalizeTender: (...args: unknown[]) => normalizeTenderMock(...args),
}));

const checkRateLimitAnomalyMock = vi.fn();
vi.mock("./rate-limit-tracking", () => ({
  checkRateLimitAnomaly: (...args: unknown[]) => checkRateLimitAnomalyMock(...args),
}));

import { formatYYYYMMDD, ingestWindow, runIncrementalIngestion } from "./ingestion.service";
import { TenderIngestedPort } from "../common/ports/tender-ingested-port";

function makeTender(pncp_control_number: string): Tender {
  return {
    pncp_control_number,
    org_cnpj: "1",
    org_name: "org",
    uf: "GO",
    municipio: "m",
    modalidade: "mod",
    uf_modalidade: "GO#mod",
    objeto: "obj",
    valor_estimado: 1,
    data_publicacao: "d",
    data_atualizacao: "d",
    situacao: "s",
    link_pncp: "l",
    keywords_tokenized: [],
    raw_payload: {},
  };
}

function fakePort(): TenderIngestedPort & { emitted: Tender[] } {
  const emitted: Tender[] = [];
  return {
    emitted,
    async emit(tender: Tender) {
      emitted.push(tender);
    },
  };
}

beforeEach(() => {
  sendMock.mockReset();
  fetchPageMock.mockReset();
  normalizeTenderMock.mockReset();
  checkRateLimitAnomalyMock.mockReset();
  sendMock.mockResolvedValue({}); // default: PutCommand de Tenders resolve ok
  normalizeTenderMock.mockImplementation((raw: Record<string, unknown>) =>
    makeTender(raw.numeroControlePNCP as string),
  );
});

describe("formatYYYYMMDD", () => {
  it("formata Date como YYYYMMDD sem separadores", () => {
    expect(formatYYYYMMDD(new Date("2026-03-05T12:00:00Z"))).toBe("20260305");
  });
});

describe("ingestWindow", () => {
  it("grava cada item (upsert por pncp_control_number) e emite pro port, avancando pagina ate totalPaginas", async () => {
    fetchPageMock
      .mockResolvedValueOnce({
        data: [{ numeroControlePNCP: "A" }, { numeroControlePNCP: "B" }],
        totalPaginas: 2,
        numeroPagina: 1,
      })
      .mockResolvedValueOnce({ data: [{ numeroControlePNCP: "C" }], totalPaginas: 2, numeroPagina: 2 })
      // modalidade 2: sem resultado (204 -> null)
      .mockResolvedValueOnce(null);

    const port = fakePort();
    const result = await ingestWindow("20260101", "20260201", port);

    expect(result.fetched).toBe(3);
    expect(result.written).toBe(3);
    expect(result.failedModalidades).toEqual([]);
    expect(port.emitted.map((t) => t.pncp_control_number)).toEqual(["A", "B", "C"]);

    // Uma unica chamada de BatchWrite por pagina do PNCP (lotes de ate 25), nao um PutItem por
    // licitacao: a ingestao grava milhares de itens por janela e o round-trip por item dominava o
    // tempo do job. Duas paginas na modalidade 1 -> dois lotes.
    const batchCalls = sendMock.mock.calls.filter(([cmd]) => cmd instanceof BatchWriteCommand);
    expect(batchCalls).toHaveLength(2);
    const itensGravados = batchCalls.flatMap(
      ([cmd]) => (cmd as BatchWriteCommand).input.RequestItems!.Tenders as { PutRequest: { Item: Tender } }[],
    );
    expect(itensGravados.map((r) => r.PutRequest.Item.pncp_control_number)).toEqual(["A", "B", "C"]);
  });

  it("pula item sem pncp_control_number (nao grava, nao emite) sem interromper o loop", async () => {
    fetchPageMock
      .mockResolvedValueOnce({
        data: [{ numeroControlePNCP: "" }, { numeroControlePNCP: "VALIDO" }],
        totalPaginas: 1,
        numeroPagina: 1,
      })
      .mockResolvedValueOnce(null);

    const port = fakePort();
    const result = await ingestWindow("20260101", "20260201", port);

    expect(result.fetched).toBe(2);
    expect(result.written).toBe(1);
    expect(port.emitted.map((t) => t.pncp_control_number)).toEqual(["VALIDO"]);
  });

  it("isola falha de uma modalidade -- as demais continuam sendo processadas (nao derruba a janela inteira)", async () => {
    fetchPageMock
      .mockRejectedValueOnce(new Error("PNCP: 429 persistente")) // modalidade 1 falha
      .mockResolvedValueOnce({ data: [{ numeroControlePNCP: "OK" }], totalPaginas: 1, numeroPagina: 1 }) // modalidade 2 funciona
      .mockResolvedValueOnce(null);

    const port = fakePort();
    const result = await ingestWindow("20260101", "20260201", port);

    expect(result.failedModalidades).toEqual([1]);
    expect(result.written).toBe(1);
    expect(port.emitted.map((t) => t.pncp_control_number)).toEqual(["OK"]);
  });

  it("roda a checagem de anomalia de rate limit ao fim, mesmo sem nenhuma falha", async () => {
    fetchPageMock.mockResolvedValue(null);
    await ingestWindow("20260101", "20260201", fakePort());
    expect(checkRateLimitAnomalyMock).toHaveBeenCalledTimes(1);
  });

  it("avanca por multiplas paginas (3) ate totalPaginas, gravando/emitindo cada item na ordem correta", async () => {
    fetchPageMock
      .mockResolvedValueOnce({ data: [{ numeroControlePNCP: "P1" }], totalPaginas: 3, numeroPagina: 1 })
      .mockResolvedValueOnce({ data: [{ numeroControlePNCP: "P2" }], totalPaginas: 3, numeroPagina: 2 })
      .mockResolvedValueOnce({ data: [{ numeroControlePNCP: "P3" }], totalPaginas: 3, numeroPagina: 3 })
      // modalidade 2: sem resultado
      .mockResolvedValueOnce(null);

    const port = fakePort();
    const result = await ingestWindow("20260101", "20260201", port);

    expect(result.fetched).toBe(3);
    expect(result.written).toBe(3);
    expect(port.emitted.map((t) => t.pncp_control_number)).toEqual(["P1", "P2", "P3"]);
    // 4 chamadas de fetchPage: 3 paginas da modalidade 1 + 1 chamada (204/null) da modalidade 2.
    expect(fetchPageMock).toHaveBeenCalledTimes(4);
    // confirma que o numero da pagina avanca corretamente a cada chamada dentro da modalidade 1.
    expect(fetchPageMock.mock.calls[0]).toEqual(["20260101", "20260201", 1, 1]);
    expect(fetchPageMock.mock.calls[1]).toEqual(["20260101", "20260201", 1, 2]);
    expect(fetchPageMock.mock.calls[2]).toEqual(["20260101", "20260201", 1, 3]);
  });

  it("trata pagina 200 com data:[] (resposta vazia, diferente de 204/null) como fim legitimo de paginacao", async () => {
    fetchPageMock
      .mockResolvedValueOnce({ data: [], totalPaginas: 1, numeroPagina: 1 })
      .mockResolvedValueOnce(null);

    const port = fakePort();
    const result = await ingestWindow("20260101", "20260201", port);

    expect(result.fetched).toBe(0);
    expect(result.written).toBe(0);
    expect(result.failedModalidades).toEqual([]);
    expect(port.emitted).toEqual([]);
  });

  it("TODAS as modalidades falhando ao mesmo tempo: nenhuma escrita, port nunca chamado, todas listadas em failedModalidades", async () => {
    fetchPageMock
      .mockRejectedValueOnce(new Error("falha modalidade 1 -- 503 persistente"))
      .mockRejectedValueOnce(new Error("falha modalidade 2 -- erro de rede"));

    const port = fakePort();
    const result = await ingestWindow("20260101", "20260201", port);

    expect(result.written).toBe(0);
    expect(result.fetched).toBe(0);
    expect(result.failedModalidades).toEqual([1, 2]);
    expect(port.emitted).toEqual([]);
    const putTenderCalls = sendMock.mock.calls.filter(
      ([cmd]) => cmd instanceof PutCommand && (cmd as PutCommand).input.TableName === "Tenders",
    );
    expect(putTenderCalls).toHaveLength(0);
    // mesmo com falha total, a checagem de anomalia ainda roda (observabilidade nunca e pulada).
    expect(checkRateLimitAnomalyMock).toHaveBeenCalledTimes(1);
  });
});

describe("runIncrementalIngestion", () => {
  it("avanca o checkpoint quando todas as modalidades processam com sucesso", async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand) return Promise.resolve({ Item: { last_processed_date: "20260101" } });
      return Promise.resolve({});
    });
    fetchPageMock.mockResolvedValue(null); // nenhum dado, nenhuma falha

    await runIncrementalIngestion(fakePort());

    const putCheckpointCalls = sendMock.mock.calls.filter(
      ([cmd]) => cmd instanceof PutCommand && (cmd as PutCommand).input.TableName === "Checkpoint",
    );
    expect(putCheckpointCalls).toHaveLength(1);
  });

  it("NAO avanca o checkpoint quando alguma modalidade falha -- proxima execucao reprocessa a mesma janela (achado critico corrigido, ver PLAN.md Secao 11)", async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand) return Promise.resolve({ Item: { last_processed_date: "20260101" } });
      return Promise.resolve({});
    });
    fetchPageMock
      .mockRejectedValueOnce(new Error("falha modalidade 1"))
      .mockRejectedValueOnce(new Error("falha modalidade 2"));

    await runIncrementalIngestion(fakePort());

    const putCheckpointCalls = sendMock.mock.calls.filter(
      ([cmd]) => cmd instanceof PutCommand && (cmd as PutCommand).input.TableName === "Checkpoint",
    );
    expect(putCheckpointCalls).toHaveLength(0);
  });

  it("comeca de ontem quando nao ha checkpoint salvo (evita full scan historico acidental)", async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand) return Promise.resolve({}); // sem Item
      return Promise.resolve({});
    });
    fetchPageMock.mockResolvedValue(null);

    await runIncrementalIngestion(fakePort());

    const yesterday = formatYYYYMMDD(new Date(Date.now() - 24 * 3600 * 1000));
    const [dataInicial] = fetchPageMock.mock.calls[0];
    expect(dataInicial).toBe(yesterday);
  });

  it("descarta checkpoint corrompido (formato invalido) e comeca de ontem, autocorrigindo em vez de travar pra sempre (achado real da Rodada 6)", async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand) return Promise.resolve({ Item: { last_processed_date: "nao-e-uma-data" } });
      return Promise.resolve({});
    });
    fetchPageMock.mockResolvedValue(null);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runIncrementalIngestion(fakePort());

    const yesterday = formatYYYYMMDD(new Date(Date.now() - 24 * 3600 * 1000));
    const [dataInicial] = fetchPageMock.mock.calls[0];
    expect(dataInicial).toBe(yesterday);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("checkpoint corrompido"));
  });

  it("descarta checkpoint com data em formato antigo/parcial (ex.: com hifens) por nao bater YYYYMMDD", async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand) return Promise.resolve({ Item: { last_processed_date: "2026-01-01" } });
      return Promise.resolve({});
    });
    fetchPageMock.mockResolvedValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runIncrementalIngestion(fakePort());

    const yesterday = formatYYYYMMDD(new Date(Date.now() - 24 * 3600 * 1000));
    const [dataInicial] = fetchPageMock.mock.calls[0];
    expect(dataInicial).toBe(yesterday);
  });

  it("aceita checkpoint valido (YYYYMMDD) normalmente, sem acionar o fallback de corrupcao", async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand) return Promise.resolve({ Item: { last_processed_date: "20260215" } });
      return Promise.resolve({});
    });
    fetchPageMock.mockResolvedValue(null);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runIncrementalIngestion(fakePort());

    const [dataInicial] = fetchPageMock.mock.calls[0];
    expect(dataInicial).toBe("20260215");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
