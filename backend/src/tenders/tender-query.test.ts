import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

// Import depois dos mocks (hoisted pelo vitest).
import { HttpError } from "../common/http-error";
import { queryTendersMerged } from "./tender-query";
import { buildTenderQueryTargets, searchTenders } from "./tenders.service";
import { TenderListItem } from "./tender.types";

function buildTender(overrides: Partial<TenderListItem> = {}): TenderListItem {
  return {
    pncp_control_number: "1",
    org_cnpj: "00000000000191",
    org_name: "Orgao Teste",
    uf: "GO",
    municipio: "Goiania",
    modalidade: "Pregão - Eletrônico",
    objeto: "objeto generico",
    valor_estimado: 1000,
    data_publicacao: "2026-08-01T00:00:00.000Z",
    data_atualizacao: "2026-08-01T00:00:00.000Z",
    situacao: "Divulgada no PNCP",
    link_pncp: "https://pncp.gov.br/x",
    keywords_tokenized: [],
    ...overrides,
  };
}

/** N itens que NUNCA batem a keyword "informatica" -- simula uma pagina bruta quase toda descartada. */
function noise(count: number, prefix: string): TenderListItem[] {
  return Array.from({ length: count }, (_, i) =>
    buildTender({ pncp_control_number: `${prefix}-${i}`, objeto: "servico de limpeza predial" }),
  );
}

function matches(count: number, prefix: string): TenderListItem[] {
  return Array.from({ length: count }, (_, i) =>
    buildTender({ pncp_control_number: `${prefix}-${i}`, objeto: "compra de informatica" }),
  );
}

const GO = { id: "uf:GO", indexName: "GSI1-uf-data_publicacao", pkName: "uf", pkValue: "GO" };
const SP = { id: "uf:SP", indexName: "GSI1-uf-data_publicacao", pkName: "uf", pkValue: "SP" };

beforeEach(() => {
  sendMock.mockReset();
});

describe("queryTendersMerged -- pagina cheia", () => {
  it("REGRESSAO: continua paginando ate juntar `limit` matches, em vez de devolver o que sobrou de uma pagina bruta", async () => {
    // O bug reportado pelo usuario: buscar por UF + palavra-chave devolvia 5 resultados, e cada
    // clique em "Carregar mais" trazia 1, 2, 0... O motivo e' que o `Limit` do DynamoDB corta ANTES
    // do filtro em memoria -- pedir 20 lia 20 itens brutos e devolvia so os que passassem no filtro.
    sendMock.mockResolvedValueOnce({ Items: noise(100, "p1"), LastEvaluatedKey: { k: 1 } });
    sendMock.mockResolvedValueOnce({ Items: noise(100, "p2"), LastEvaluatedKey: { k: 2 } });
    sendMock.mockResolvedValueOnce({ Items: matches(50, "p3"), LastEvaluatedKey: { k: 3 } });

    const result = await queryTendersMerged({
      targets: [GO],
      limit: 20,
      sort: "desc",
      accept: (t) => t.objeto.includes("informatica"),
    });

    expect(result.data).toHaveLength(20);
    expect(result.has_more).toBe(true);
    expect(result.partial).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it("devolve menos que `limit` (sem cursor) so quando os dados realmente acabaram", async () => {
    sendMock.mockResolvedValueOnce({ Items: matches(3, "unica"), LastEvaluatedKey: undefined });

    const result = await queryTendersMerged({ targets: [GO], limit: 20, sort: "desc" });

    expect(result.data).toHaveLength(3);
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeUndefined();
  });

  it("ao bater o teto de leitura devolve pagina curta COM cursor e partial:true, nunca 'acabou' silencioso", async () => {
    for (let i = 0; i < 50; i++) {
      sendMock.mockResolvedValueOnce({ Items: noise(100, `p${i}`), LastEvaluatedKey: { k: i } });
    }

    const result = await queryTendersMerged({
      targets: [GO],
      limit: 20,
      sort: "desc",
      accept: (t) => t.objeto.includes("informatica"),
    });

    expect(result.data).toHaveLength(0);
    expect(result.partial).toBe(true);
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBeDefined();
    expect(sendMock).toHaveBeenCalledTimes(40);
  });
});

describe("queryTendersMerged -- merge de varios streams", () => {
  it("ordena globalmente por data_publicacao, nao concatena um stream depois do outro", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        buildTender({ pncp_control_number: "go-1", data_publicacao: "2026-09-05T00:00:00.000Z" }),
        buildTender({ pncp_control_number: "go-2", data_publicacao: "2026-09-01T00:00:00.000Z" }),
      ],
    });
    sendMock.mockResolvedValueOnce({
      Items: [
        buildTender({ pncp_control_number: "sp-1", data_publicacao: "2026-09-06T00:00:00.000Z" }),
        buildTender({ pncp_control_number: "sp-2", data_publicacao: "2026-09-03T00:00:00.000Z" }),
      ],
    });

    const result = await queryTendersMerged({ targets: [GO, SP], limit: 10, sort: "desc" });

    expect(result.data.map((t) => t.pncp_control_number)).toEqual(["sp-1", "go-1", "sp-2", "go-2"]);
  });

  it("REGRESSAO: multi-valor agora pagina -- o cursor guarda a posicao de CADA stream separadamente", async () => {
    // Antes, informar mais de uma UF desligava a paginacao inteira (400 explicito no backend e
    // botao "Carregar mais" desabilitado no frontend), porque cada valor tinha seu proprio
    // LastEvaluatedKey e nao havia um cursor unico que representasse os dois.
    sendMock.mockResolvedValueOnce({
      Items: [buildTender({ pncp_control_number: "go-1", data_publicacao: "2026-09-05T00:00:00.000Z" })],
      LastEvaluatedKey: { k: "go" },
    });
    sendMock.mockResolvedValueOnce({
      Items: [buildTender({ pncp_control_number: "sp-1", data_publicacao: "2026-09-06T00:00:00.000Z" })],
      LastEvaluatedKey: { k: "sp" },
    });

    const first = await queryTendersMerged({ targets: [GO, SP], limit: 1, sort: "desc" });

    expect(first.data.map((t) => t.pncp_control_number)).toEqual(["sp-1"]);
    expect(first.next_cursor).toBeDefined();

    sendMock.mockReset();
    sendMock.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    sendMock.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

    await queryTendersMerged({ targets: [GO, SP], limit: 1, sort: "desc", cursor: first.next_cursor });

    // SP avancou pelo item ja entregue; GO nao consumiu nada e recomeca do inicio -- e' isso que
    // impede tanto item repetido quanto item pulado entre paginas.
    const startKeys = sendMock.mock.calls.map((c) => c[0].input.ExclusiveStartKey);
    expect(startKeys[0]).toBeUndefined();
    expect(startKeys[1]).toEqual({
      pncp_control_number: "sp-1",
      uf: "SP",
      data_publicacao: "2026-09-06T00:00:00.000Z",
    });
  });

  it("rejeita cursor invalido com 400, sem derrubar o processo", async () => {
    await expect(
      queryTendersMerged({ targets: [GO], limit: 10, sort: "desc", cursor: "lixo-nao-base64-json" }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

describe("buildTenderQueryTargets", () => {
  it("so uf -> uma Query por UF na GSI1", () => {
    expect(buildTenderQueryTargets(["GO", "SP"], [])).toEqual([
      { id: "uf:GO", indexName: "GSI1-uf-data_publicacao", pkName: "uf", pkValue: "GO" },
      { id: "uf:SP", indexName: "GSI1-uf-data_publicacao", pkName: "uf", pkValue: "SP" },
    ]);
  });

  it("so modalidade -> uma Query por modalidade na GSI2", () => {
    expect(buildTenderQueryTargets([], ["Dispensa"])).toEqual([
      { id: "mo:Dispensa", indexName: "GSI2-modalidade-data_publicacao", pkName: "modalidade", pkValue: "Dispensa" },
    ]);
  });

  it("uf + modalidade -> produto cartesiano na GSI4 (a busca que antes era 400)", () => {
    const targets = buildTenderQueryTargets(["GO", "SP"], ["Dispensa", "Concurso"]);

    expect(targets).toHaveLength(4);
    expect(targets.every((t) => t.indexName === "GSI4-uf_modalidade-data_publicacao")).toBe(true);
    expect(targets.map((t) => t.pkValue)).toEqual([
      "GO#Dispensa",
      "GO#Concurso",
      "SP#Dispensa",
      "SP#Concurso",
    ]);
  });

  it("sem uf e sem modalidade -> 400 (nunca Scan na tabela inteira)", () => {
    expect(() => buildTenderQueryTargets([], [])).toThrow(HttpError);
  });

  it("rejeita combinacao cujo produto cartesiano estoura o teto de consultas por requisicao", () => {
    const cincoUfs = ["GO", "SP", "MG", "RJ", "BA"];
    const cincoModalidades = ["Dispensa", "Concurso", "Credenciamento", "Inexigibilidade", "Leilão - Presencial"];
    expect(() => buildTenderQueryTargets(cincoUfs, cincoModalidades)).toThrow(HttpError);
  });
});

describe("searchTenders -- filtros aplicados sobre os streams", () => {
  it("filtra por municipio e situacao ignorando acento e caixa", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        buildTender({ pncp_control_number: "1", municipio: "Goiânia", situacao: "Divulgada no PNCP" }),
        buildTender({ pncp_control_number: "2", municipio: "Anápolis", situacao: "Divulgada no PNCP" }),
        buildTender({ pncp_control_number: "3", municipio: "Goiânia", situacao: "Revogada" }),
      ],
    });

    const result = await searchTenders({ uf: ["GO"], municipio: "goiania", situacao: ["divulgada"] });

    expect(result.data.map((t) => t.pncp_control_number)).toEqual(["1"]);
  });

  it("usa a GSI4 quando uf e modalidade vem juntos", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });

    await searchTenders({ uf: ["GO"], modalidade: ["Pregão - Eletrônico"] });

    const call = sendMock.mock.calls[0][0];
    expect(call).toBeInstanceOf(QueryCommand);
    expect(call.input.IndexName).toBe("GSI4-uf_modalidade-data_publicacao");
    expect(call.input.ExpressionAttributeValues[":pk"]).toBe("GO#Pregão - Eletrônico");
  });

  it("nunca projeta raw_payload nas rotas de lista", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });

    await searchTenders({ uf: ["GO"] });

    const call = sendMock.mock.calls[0][0];
    expect(call.input.ProjectionExpression).toBeDefined();
    expect(Object.values(call.input.ExpressionAttributeNames)).not.toContain("raw_payload");
    expect(Object.values(call.input.ExpressionAttributeNames)).toContain("objeto");
  });
});
