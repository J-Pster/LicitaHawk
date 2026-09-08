import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// pncp-client importa recordRateLimitAttempt de rate-limit-tracking.ts, que por sua vez usa
// ddbDocClient real (dynamodb-client.ts). normalizeTender (unica funcao testada aqui) nao usa
// essa dependencia, mas o import estatico do modulo dispara a cadeia inteira se nao for mockado.
// vi.mock e' hoisted pelo vitest pro topo do arquivo, entao roda antes do import abaixo.
vi.mock("./rate-limit-tracking", () => ({
  recordRateLimitAttempt: vi.fn(),
  checkRateLimitAnomaly: vi.fn(),
}));

import { fetchContratacoesAtualizacaoPage, normalizeTender } from "./pncp-client";

describe("normalizeTender", () => {
  it("normaliza um payload completo do PNCP pro schema interno de Tender", () => {
    const raw = {
      numeroControlePNCP: "12345678000199-1-000001/2026",
      orgaoEntidade: { cnpj: "12345678000199", razaoSocial: "Prefeitura Municipal Teste" },
      unidadeOrgao: { ufSigla: "GO", municipioNome: "Goiania" },
      modalidadeNome: "Pregão - Eletrônico",
      objetoCompra: "Aquisição de Software de Gestão Pública",
      valorTotalEstimado: 150000.5,
      dataPublicacaoPncp: "2026-01-15T10:00:00Z",
      dataAtualizacaoGlobal: "2026-01-16T10:00:00Z",
      situacaoCompraNome: "Divulgada no PNCP",
      anoCompra: 2026,
      sequencialCompra: 1,
    };

    const tender = normalizeTender(raw);

    expect(tender.pncp_control_number).toBe("12345678000199-1-000001/2026");
    expect(tender.org_cnpj).toBe("12345678000199");
    expect(tender.org_name).toBe("Prefeitura Municipal Teste");
    expect(tender.uf).toBe("GO");
    expect(tender.municipio).toBe("Goiania");
    expect(tender.modalidade).toBe("Pregão - Eletrônico");
    expect(tender.objeto).toBe("Aquisição de Software de Gestão Pública");
    expect(tender.valor_estimado).toBe(150000.5);
    expect(tender.situacao).toBe("Divulgada no PNCP");
    expect(tender.link_pncp).toBe("https://pncp.gov.br/app/editais/12345678000199/2026/1");
  });

  it("tokeniza objetoCompra sem acento, minusculo, tokens curtos (<=2 chars) removidos", () => {
    const raw = { objetoCompra: "Construção de praça e reforma de UBS" };
    const tender = normalizeTender(raw);
    expect(tender.keywords_tokenized).toContain("construcao");
    expect(tender.keywords_tokenized).toContain("praca");
    expect(tender.keywords_tokenized).toContain("reforma");
    // "de" e "e" tem <=2 chars, devem ser filtrados
    expect(tender.keywords_tokenized).not.toContain("de");
    expect(tender.keywords_tokenized).not.toContain("e");
  });

  it("usa dataAtualizacao como fallback quando dataAtualizacaoGlobal esta ausente", () => {
    const raw = { dataAtualizacao: "2026-02-01T00:00:00Z" };
    const tender = normalizeTender(raw);
    expect(tender.data_atualizacao).toBe("2026-02-01T00:00:00Z");
  });

  it("nunca lanca com payload vazio -- campos ausentes viram string vazia / 0 (Risco #2 do PLAN.md)", () => {
    expect(() => normalizeTender({})).not.toThrow();
    const tender = normalizeTender({});
    expect(tender.pncp_control_number).toBe("");
    expect(tender.org_cnpj).toBe("");
    expect(tender.valor_estimado).toBe(0);
    expect(tender.keywords_tokenized).toEqual([]);
  });

  it("nunca lanca quando orgaoEntidade/unidadeOrgao sao null (nao so undefined)", () => {
    const raw = { orgaoEntidade: null, unidadeOrgao: null, objetoCompra: "teste" };
    expect(() => normalizeTender(raw as Record<string, unknown>)).not.toThrow();
  });

  it("preserva o raw_payload original", () => {
    const raw = { numeroControlePNCP: "X", campoDesconhecido: "valor-futuro-do-pncp" };
    const tender = normalizeTender(raw);
    expect(tender.raw_payload).toBe(raw);
  });
});

describe("fetchContratacoesAtualizacaoPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retorna a pagina em caso de sucesso (200) na primeira tentativa", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ numeroControlePNCP: "A" }], totalPaginas: 1, numeroPagina: 1 }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchContratacoesAtualizacaoPage("20260101", "20260201", 1, 1);
    await vi.runAllTimersAsync();
    const page = await promise;

    expect(page).toEqual({ data: [{ numeroControlePNCP: "A" }], totalPaginas: 1, numeroPagina: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passa um AbortSignal com timeout em toda chamada (achado real da Rodada 6 -- fetch sem timeout podia travar minutos)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchContratacoesAtualizacaoPage("20260101", "20260201", 1, 1);
    await vi.runAllTimersAsync();
    await promise;

    const [, options] = fetchMock.mock.calls[0];
    expect((options as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it("retorna null em 204 (sem resultados para a combinacao modalidade/janela/pagina)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchContratacoesAtualizacaoPage("20260101", "20260201", 1, 1);
    await vi.runAllTimersAsync();
    expect(await promise).toBeNull();
  });

  it("lanca imediatamente em 422 (parametro invalido), sem nenhuma tentativa de retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchContratacoesAtualizacaoPage("20260101", "20260201", 1, 1);
    const assertion = expect(promise).rejects.toThrow(/422/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("em 429, aplica backoff exponencial e tenta de novo, sucedendo na segunda tentativa", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ numeroControlePNCP: "B" }], totalPaginas: 1, numeroPagina: 1 }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchContratacoesAtualizacaoPage("20260101", "20260201", 1, 1);
    await vi.runAllTimersAsync();
    const page = await promise;

    expect(page).toEqual({ data: [{ numeroControlePNCP: "B" }], totalPaginas: 1, numeroPagina: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("erro de rede (fetch rejeita, ex.: timeout do AbortSignal) aciona o mesmo caminho de backoff e retry", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], totalPaginas: 1, numeroPagina: 1 }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchContratacoesAtualizacaoPage("20260101", "20260201", 1, 1);
    await vi.runAllTimersAsync();
    const page = await promise;

    expect(page).toEqual({ data: [], totalPaginas: 1, numeroPagina: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lanca apos esgotar as tentativas de retry quando a falha e persistente (ex.: 503 continuo)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchContratacoesAtualizacaoPage("20260101", "20260201", 1, 1);
    const assertion = expect(promise).rejects.toThrow(/Excedeu 5 tentativas/);
    await vi.runAllTimersAsync();
    await assertion;
    // 5 retries com backoff + a tentativa final que estoura o limite = 6 chamadas reais de fetch.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
