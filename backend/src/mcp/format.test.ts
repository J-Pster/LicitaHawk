import { describe, expect, it } from "vitest";
import { formatSearchResult, formatTenderDetail, formatTenderStats } from "./format";
import { Tender } from "../tenders/tender.types";
import { TenderSearchResult } from "../tenders/tenders.service";

function buildTender(overrides: Partial<Tender> = {}): Tender {
  return {
    pncp_control_number: "12345678000199-1-000045/2026",
    org_cnpj: "12345678000199",
    org_name: "Prefeitura de Exemplo",
    uf: "GO",
    municipio: "Goiania",
    modalidade: "Pregão - Eletrônico",
    uf_modalidade: "GO#Pregão - Eletrônico",
    objeto: "Aquisicao de material de escritorio",
    valor_estimado: 15000.5,
    data_publicacao: "2026-09-01",
    data_atualizacao: "2026-09-02",
    situacao: "Divulgada no PNCP",
    link_pncp: "https://pncp.gov.br/app/editais/12345678000199/2026/45",
    keywords_tokenized: ["aquisicao", "material", "escritorio"],
    raw_payload: { foo: "bar" },
    ...overrides,
  };
}

describe("formatSearchResult", () => {
  it("retorna mensagem de vazio quando nenhuma licitacao e encontrada", () => {
    const result: TenderSearchResult = { data: [], has_more: false, partial: false };
    const text = formatSearchResult(result, "UF GO");
    expect(text).toContain("Nenhuma licitacao encontrada");
    expect(text).toContain("UF GO");
  });

  it("lista licitacoes numeradas com valor em BRL e link do PNCP", () => {
    const result: TenderSearchResult = { data: [buildTender()], has_more: false, partial: false };
    const text = formatSearchResult(result, "UF GO");
    expect(text).toContain("1 licitacao(oes) encontrada(s)");
    expect(text).toContain("1. [Pregão - Eletrônico]");
    expect(text).toContain("R$");
    expect(text).toContain("https://pncp.gov.br/app/editais/12345678000199/2026/45");
  });

  it("trunca 'objeto' acima de 280 caracteres na listagem", () => {
    const longObjeto = "a".repeat(300);
    const result: TenderSearchResult = { data: [buildTender({ objeto: longObjeto })], has_more: false, partial: false };
    const text = formatSearchResult(result, "UF GO");
    expect(text).toContain("...");
    expect(text).not.toContain("a".repeat(300));
  });

  it("nao trunca 'objeto' com 280 caracteres ou menos", () => {
    const shortObjeto = "b".repeat(280);
    const result: TenderSearchResult = { data: [buildTender({ objeto: shortObjeto })], has_more: false, partial: false };
    const text = formatSearchResult(result, "UF GO");
    expect(text).toContain(shortObjeto);
    expect(text).not.toContain("...");
  });

  it("nunca vaza raw_payload ou keywords_tokenized na resposta", () => {
    const result: TenderSearchResult = { data: [buildTender()], has_more: false, partial: false };
    const text = formatSearchResult(result, "UF GO");
    expect(text).not.toContain("foo");
    expect(text).not.toContain("bar");
    expect(text).not.toContain("aquisicao,material,escritorio");
  });

  it("adiciona nota de paginacao quando next_cursor esta presente", () => {
    const result: TenderSearchResult = { data: [buildTender()], next_cursor: "abc123", has_more: true, partial: false };
    const text = formatSearchResult(result, "UF GO");
    expect(text).toContain("Ha mais resultados disponiveis");
  });

  it("nao adiciona nota de paginacao quando next_cursor esta ausente", () => {
    const result: TenderSearchResult = { data: [buildTender()], has_more: false, partial: false };
    const text = formatSearchResult(result, "UF GO");
    expect(text).not.toContain("Ha mais resultados disponiveis");
  });

  it("formata valor_estimado ausente/nulo como 'valor nao informado'", () => {
    const result: TenderSearchResult = { data: [buildTender({ valor_estimado: null as unknown as number })], has_more: false, partial: false };
    const text = formatSearchResult(result, "UF GO");
    expect(text).toContain("valor nao informado");
  });
});

describe("formatTenderDetail", () => {
  it("inclui todos os campos principais, sem truncar objeto", () => {
    const longObjeto = "c".repeat(500);
    const tender = buildTender({ objeto: longObjeto });
    const text = formatTenderDetail(tender);
    expect(text).toContain(tender.pncp_control_number);
    expect(text).toContain(tender.org_name);
    expect(text).toContain(tender.org_cnpj);
    expect(text).toContain(`${tender.municipio}/${tender.uf}`);
    expect(text).toContain(longObjeto);
    expect(text).not.toContain("...");
  });

  it("nunca vaza raw_payload no detalhe", () => {
    const tender = buildTender({ raw_payload: { segredo: "nao deveria aparecer" } });
    const text = formatTenderDetail(tender);
    expect(text).not.toContain("segredo");
    expect(text).not.toContain("nao deveria aparecer");
  });
});

describe("formatTenderStats", () => {
  it("retorna mensagem de vazio quando nao ha licitacoes", () => {
    const text = formatTenderStats([], 50, "UF GO");
    expect(text).toContain("Nenhuma licitacao encontrada");
  });

  it("calcula total e media corretamente sobre a amostra", () => {
    const tenders = [
      buildTender({ valor_estimado: 100, modalidade: "Pregão - Eletrônico" }),
      buildTender({ valor_estimado: 300, modalidade: "Pregão - Eletrônico" }),
      buildTender({ valor_estimado: 200, modalidade: "Concorrência" }),
    ];
    const text = formatTenderStats(tenders, 50, "UF GO");
    expect(text).toContain("Resumo de 3 licitacao(oes)");
    // total = 600, media = 200
    expect(text).toMatch(/600,00/);
    expect(text).toMatch(/200,00/);
  });

  it("quebra por modalidade em ordem decrescente de contagem", () => {
    const tenders = [
      buildTender({ modalidade: "Concorrência" }),
      buildTender({ modalidade: "Pregão - Eletrônico" }),
      buildTender({ modalidade: "Pregão - Eletrônico" }),
    ];
    const text = formatTenderStats(tenders, 50, "UF GO");
    const pregaoIndex = text.indexOf("Pregão - Eletrônico: 2");
    const concorrenciaIndex = text.indexOf("Concorrência: 1");
    expect(pregaoIndex).toBeGreaterThan(-1);
    expect(concorrenciaIndex).toBeGreaterThan(-1);
    expect(pregaoIndex).toBeLessThan(concorrenciaIndex);
  });

  it("trata valor_estimado ausente/nulo como 0 no total (nunca lanca)", () => {
    const tenders = [buildTender({ valor_estimado: null as unknown as number })];
    expect(() => formatTenderStats(tenders, 50, "UF GO")).not.toThrow();
  });

  it("adiciona nota de limitacao de amostra quando a amostra bate o teto do plano", () => {
    const tenders = [buildTender(), buildTender()];
    const text = formatTenderStats(tenders, 2, "UF GO");
    expect(text).toContain("Nota: resumo baseado nas 2 licitacoes mais recentes");
  });

  it("nao adiciona nota de limitacao quando a amostra fica abaixo do teto do plano", () => {
    const tenders = [buildTender()];
    const text = formatTenderStats(tenders, 50, "UF GO");
    expect(text).not.toContain("Nota: resumo baseado");
  });
});
