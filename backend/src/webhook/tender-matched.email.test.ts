import { describe, expect, it } from "vitest";
import { TenderMatchedPayload } from "../common/ports/alert-queue-port";
import { renderTenderMatchedEmail } from "./tender-matched.email";

function payload(overrides: Partial<TenderMatchedPayload["tender"]> = {}, test = false): TenderMatchedPayload {
  return {
    event: "tender.matched",
    filter_id: "filter-1",
    ...(test ? { test: true } : {}),
    tender: {
      pncp_control_number: "12345/2026",
      org_cnpj: "12345678000199",
      org_name: "Prefeitura de Goiania",
      uf: "GO",
      modalidade: "Pregão - Eletrônico",
      objeto: "Aquisicao de merenda escolar",
      valor_estimado: 1234.5,
      link_pncp: "https://pncp.gov.br/app/editais/1",
      ...overrides,
    },
  };
}

describe("renderTenderMatchedEmail", () => {
  it("monta assunto com UF e objeto", () => {
    expect(renderTenderMatchedEmail(payload()).subject).toBe(
      "Nova licitacao em GO: Aquisicao de merenda escolar",
    );
  });

  it("trunca objeto longo no assunto", () => {
    const subject = renderTenderMatchedEmail(payload({ objeto: "a".repeat(200) })).subject;

    expect(subject.length).toBeLessThan(120);
    expect(subject.endsWith("...")).toBe(true);
  });

  it("marca disparo de teste no assunto e no corpo", () => {
    const rendered = renderTenderMatchedEmail(payload({}, true));

    expect(rendered.subject.startsWith("[Teste] ")).toBe(true);
    expect(rendered.html).toContain("disparo de teste");
    expect(rendered.text).toContain("[Teste]");
  });

  it("formata valor em BRL e diz 'nao informado' quando nulo", () => {
    expect(renderTenderMatchedEmail(payload()).text).toContain("1.234,50");
    expect(renderTenderMatchedEmail(payload({ valor_estimado: null })).text).toContain("nao informado");
  });

  it("formata o CNPJ e mantem o valor cru quando nao tem 14 digitos", () => {
    expect(renderTenderMatchedEmail(payload()).text).toContain("12.345.678/0001-99");
    expect(renderTenderMatchedEmail(payload({ org_cnpj: "123" })).text).toContain("123");
  });

  it("SEGURANCA: escapa HTML vindo do PNCP em vez de deixar virar markup", () => {
    const rendered = renderTenderMatchedEmail(
      payload({ objeto: '<img src=x onerror="alert(1)">', org_name: "Orgao & Cia" }),
    );

    expect(rendered.html).not.toContain("<img src=x");
    expect(rendered.html).toContain("&lt;img src=x");
    expect(rendered.html).toContain("Orgao &amp; Cia");
  });

  it("SEGURANCA: link fora de http(s) nao vira href clicavel", () => {
    const rendered = renderTenderMatchedEmail(payload({ link_pncp: "javascript:alert(1)" }));

    expect(rendered.html).not.toContain("javascript:");
    expect(rendered.html).toContain('href="https://pncp.gov.br"');
  });

  it("mantem o link real quando e' http(s)", () => {
    expect(renderTenderMatchedEmail(payload()).html).toContain('href="https://pncp.gov.br/app/editais/1"');
  });

  it("gera versao texto com os mesmos dados do HTML", () => {
    const { text } = renderTenderMatchedEmail(payload());

    expect(text).toContain("Prefeitura de Goiania");
    expect(text).toContain("Pregão - Eletrônico");
    expect(text).toContain("https://pncp.gov.br/app/editais/1");
  });
});
