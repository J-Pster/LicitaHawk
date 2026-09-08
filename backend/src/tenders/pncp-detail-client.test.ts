import { describe, expect, it } from "vitest";
import { arquivoDownloadUrl, parseControlNumber } from "./pncp-detail-client";

describe("parseControlNumber", () => {
  it("quebra o numero de controle oficial em cnpj, sequencial e ano", () => {
    expect(parseControlNumber("07533656000119-1-000134/2026")).toEqual({
      cnpj: "07533656000119",
      sequencial: 134,
      ano: 2026,
    });
  });

  it("ignora zeros a esquerda do sequencial (o PNCP usa 6 digitos, a rota usa o numero)", () => {
    expect(parseControlNumber("46612032000149-1-000188/2024")?.sequencial).toBe(188);
  });

  it("tolera espaco em volta, que chega da URL", () => {
    expect(parseControlNumber("  07533656000119-1-000134/2026 ")?.ano).toBe(2026);
  });

  it("devolve null (nao lanca) para formato invalido, porque o valor vem de fora", () => {
    for (const invalido of [
      "",
      "qualquer-coisa",
      "0753365600011-1-000134/2026", // CNPJ com 13 digitos
      "07533656000119-1-000134/26", // ano com 2 digitos
      "07533656000119/2026",
      "<script>alert(1)</script>",
    ]) {
      expect(parseControlNumber(invalido)).toBeNull();
    }
  });
});

describe("arquivoDownloadUrl", () => {
  it("monta a URL de download a partir da base atual, nao do caminho legado devolvido pelo PNCP", () => {
    const url = arquivoDownloadUrl({ cnpj: "07533656000119", ano: 2026, sequencial: 134 }, 3);
    expect(url).toBe(
      "https://pncp.gov.br/api/pncp/v1/orgaos/07533656000119/compras/2026/134/arquivos/3",
    );
  });
});
