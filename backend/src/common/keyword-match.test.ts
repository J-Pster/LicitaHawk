import { describe, expect, it } from "vitest";
import { matchesKeyword } from "./keyword-match";
import { Tender } from "../tenders/tender.types";

function makeTender(overrides: Partial<Tender> = {}): Tender {
  return {
    pncp_control_number: "1",
    org_cnpj: "00000000000000",
    org_name: "Orgao Teste",
    uf: "GO",
    municipio: "Goiania",
    modalidade: "Pregão - Eletrônico",
    uf_modalidade: "GO#Pregão - Eletrônico",
    objeto: "",
    valor_estimado: 0,
    data_publicacao: "2026-01-01",
    data_atualizacao: "2026-01-01",
    situacao: "Divulgada",
    link_pncp: "https://pncp.gov.br/app/editais/x/2026/1",
    keywords_tokenized: [],
    raw_payload: {},
    ...overrides,
  };
}

describe("matchesKeyword", () => {
  it("retorna true quando keyword e undefined (sem filtro)", () => {
    expect(matchesKeyword(makeTender({ objeto: "qualquer coisa" }), undefined)).toBe(true);
  });

  it("retorna true quando keyword e string vazia/so espaco", () => {
    expect(matchesKeyword(makeTender({ objeto: "qualquer coisa" }), "   ")).toBe(true);
  });

  it("acha por substring case-insensitive no objeto", () => {
    const tender = makeTender({ objeto: "Aquisicao de Software de Gestao" });
    expect(matchesKeyword(tender, "SOFTWARE")).toBe(true);
    expect(matchesKeyword(tender, "software")).toBe(true);
  });

  it("acha ignorando acento em ambas as direcoes (objeto acentuado, busca sem acento e vice-versa)", () => {
    const tender = makeTender({ objeto: "Construção de praça pública" });
    expect(matchesKeyword(tender, "construcao")).toBe(true);
    expect(matchesKeyword(tender, "praça")).toBe(true);
    expect(matchesKeyword(tender, "PRACA")).toBe(true);
  });

  it("acha via keywords_tokenized quando objeto nao bate (achado real corrigido: inconsistencia de normalizacao entre os dois caminhos)", () => {
    const tender = makeTender({ objeto: "", keywords_tokenized: ["informatica", "servico"] });
    expect(matchesKeyword(tender, "INFORMÁTICA")).toBe(true);
  });

  it("nao acha quando a keyword nao esta presente em nenhum dos dois campos", () => {
    const tender = makeTender({ objeto: "Compra de merenda escolar", keywords_tokenized: ["merenda", "escolar"] });
    expect(matchesKeyword(tender, "software")).toBe(false);
  });

  it("lida com objeto ausente/undefined sem lancar", () => {
    const tender = makeTender({ objeto: undefined as unknown as string, keywords_tokenized: ["software"] });
    expect(matchesKeyword(tender, "software")).toBe(true);
    expect(matchesKeyword(tender, "outracoisa")).toBe(false);
  });

  it("lida com keywords_tokenized ausente sem lancar", () => {
    const tender = makeTender({ objeto: "software", keywords_tokenized: undefined as unknown as string[] });
    expect(matchesKeyword(tender, "software")).toBe(true);
  });
});
