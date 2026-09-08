import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

// Import depois dos mocks (hoisted pelo vitest).
import { findRecentlyUpdatedMatches } from "./tenders.service";
import { Tender } from "./tender.types";

function buildTender(overrides: Partial<Tender>): Tender {
  return {
    pncp_control_number: "1",
    org_cnpj: "00000000000191",
    org_name: "Orgao Teste",
    uf: "GO",
    municipio: "Goiania",
    modalidade: "Pregão - Eletrônico",
    uf_modalidade: "GO#Pregão - Eletrônico",
    objeto: "objeto generico",
    valor_estimado: 1000,
    data_publicacao: "2026-08-01T00:00:00.000Z",
    data_atualizacao: "2026-08-01T00:00:00.000Z",
    situacao: "divulgada",
    link_pncp: "https://pncp.gov.br/x",
    keywords_tokenized: [],
    raw_payload: {},
    ...overrides,
  };
}

beforeEach(() => {
  sendMock.mockReset();
});

describe("findRecentlyUpdatedMatches", () => {
  it("consulta GSI4-uf_modalidade-data_publicacao pela chave composta (nunca Scan)", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });

    await findRecentlyUpdatedMatches({ uf: "GO", modalidade: "Pregão - Eletrônico" });

    const call = sendMock.mock.calls[0][0];
    expect(call).toBeInstanceOf(QueryCommand);
    expect(call.input.IndexName).toBe("GSI4-uf_modalidade-data_publicacao");
    expect(call.input.ExpressionAttributeValues[":pk"]).toBe("GO#Pregão - Eletrônico");
  });

  it("le so a particao exata uf+modalidade -- a modalidade deixou de ser filtro em memoria", async () => {
    // Antes, esta previa consultava a UF inteira (GSI1) e descartava em memoria tudo que nao fosse
    // da modalidade pedida, com teto de 200 itens lidos: numa UF grande, o teto se gastava quase
    // todo em itens de outras modalidades. Agora a particao consultada JA e' o par (uf, modalidade).
    sendMock.mockResolvedValueOnce({
      Items: [
        buildTender({ pncp_control_number: "1", modalidade: "Pregão - Eletrônico" }),
        buildTender({ pncp_control_number: "2", modalidade: "Pregão - Eletrônico" }),
      ],
    });

    const result = await findRecentlyUpdatedMatches({ uf: "GO", modalidade: "Pregão - Eletrônico" });

    expect(result.tenders).toHaveLength(2);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("filtra por keyword (objeto/keywords_tokenized) quando informada", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        buildTender({ pncp_control_number: "1", objeto: "compra de informatica" }),
        buildTender({ pncp_control_number: "2", objeto: "servico de limpeza" }),
      ],
    });

    const result = await findRecentlyUpdatedMatches({ uf: "GO", modalidade: "Pregão - Eletrônico", keyword: "informatica" });

    expect(result.tenders).toHaveLength(1);
    expect(result.tenders[0].pncp_control_number).toBe("1");
  });

  it("com 'since', so devolve tenders com data_atualizacao estritamente posterior", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        buildTender({ pncp_control_number: "antigo", data_atualizacao: "2026-08-01T00:00:00.000Z" }),
        buildTender({ pncp_control_number: "novo", data_atualizacao: "2026-09-07T00:00:00.000Z" }),
      ],
    });

    const result = await findRecentlyUpdatedMatches({
      uf: "GO",
      modalidade: "Pregão - Eletrônico",
      since: "2026-09-01T00:00:00.000Z",
    });

    expect(result.tenders).toHaveLength(1);
    expect(result.tenders[0].pncp_control_number).toBe("novo");
  });

  it("ordena por data_atualizacao desc (mais recente primeiro) e devolve 'since' = timestamp mais recente encontrado", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        buildTender({ pncp_control_number: "a", data_atualizacao: "2026-09-01T00:00:00.000Z" }),
        buildTender({ pncp_control_number: "b", data_atualizacao: "2026-09-07T00:00:00.000Z" }),
        buildTender({ pncp_control_number: "c", data_atualizacao: "2026-09-05T00:00:00.000Z" }),
      ],
    });

    const result = await findRecentlyUpdatedMatches({ uf: "GO", modalidade: "Pregão - Eletrônico" });

    expect(result.tenders.map((t) => t.pncp_control_number)).toEqual(["b", "c", "a"]);
    expect(result.since).toBe("2026-09-07T00:00:00.000Z");
  });

  it("sem match nenhum, devolve lista vazia e ecoa o 'since' recebido de volta", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });

    const result = await findRecentlyUpdatedMatches({
      uf: "GO",
      modalidade: "Pregão - Eletrônico",
      since: "2026-09-01T00:00:00.000Z",
    });

    expect(result.tenders).toEqual([]);
    expect(result.since).toBe("2026-09-01T00:00:00.000Z");
  });

  it("sem match nenhum e sem 'since' de entrada (1a chamada), devolve since undefined", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });

    const result = await findRecentlyUpdatedMatches({ uf: "GO", modalidade: "Pregão - Eletrônico" });

    expect(result.tenders).toEqual([]);
    expect(result.since).toBeUndefined();
  });
});
