import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

// Import depois dos mocks (hoisted pelo vitest).
import { countNewMatchesForSavedSearch, createSavedSearch } from "./saved-searches.service";
import { SavedSearch } from "./saved-search.types";
import { Tender } from "../tenders/tender.types";
import { HttpError } from "../common/http-error";
import { MAX_MULTI_VALUES } from "../common/query-validation";

function buildSavedSearch(overrides: Partial<SavedSearch> = {}): SavedSearch {
  return {
    account_id: "acc-1",
    saved_search_id: "ss-1",
    name: "Meu filtro",
    criteria: { uf: ["GO"], keyword: "informatica" },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildTender(overrides: Partial<Tender>): Tender {
  return {
    pncp_control_number: "1",
    org_cnpj: "00000000000191",
    org_name: "Orgao Teste",
    uf: "GO",
    municipio: "Goiania",
    modalidade: "Pregão - Eletrônico",
    uf_modalidade: "GO#Pregão - Eletrônico",
    objeto: "servico de limpeza",
    valor_estimado: 1000,
    data_publicacao: "2026-08-10T00:00:00.000Z",
    data_atualizacao: "2026-08-10T00:00:00.000Z",
    situacao: "divulgada",
    link_pncp: "https://pncp.gov.br/x",
    keywords_tokenized: [],
    raw_payload: {},
    ...overrides,
  };
}

function nonMatchingTenders(count: number, controlPrefix: string): Tender[] {
  return Array.from({ length: count }, (_, i) =>
    buildTender({ pncp_control_number: `${controlPrefix}-${i}`, objeto: "servico de limpeza" }),
  );
}

beforeEach(() => {
  sendMock.mockReset();
});

describe("countNewMatchesForSavedSearch", () => {
  it("pagina alem da primeira janela pra nao subestimar a contagem quando keyword filtra a maior parte da 1a pagina", async () => {
    const savedSearch = buildSavedSearch();
    sendMock.mockResolvedValueOnce({ Item: savedSearch }); // assertSavedSearchOwnership
    sendMock.mockResolvedValueOnce({
      Items: nonMatchingTenders(100, "pagina1"),
      LastEvaluatedKey: { pncp_control_number: "pagina1-99" },
    });
    sendMock.mockResolvedValueOnce({
      Items: [
        buildTender({ pncp_control_number: "pagina2-0", objeto: "compra de informatica" }),
        buildTender({ pncp_control_number: "pagina2-1", objeto: "compra de informatica" }),
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await countNewMatchesForSavedSearch("acc-1", "ss-1");

    expect(result).toEqual({ found: true, new_count: 2 });

    // 1 GetCommand (ownership) + 2 QueryCommand (paginacao)
    expect(sendMock).toHaveBeenCalledTimes(3);
    const secondQuery = sendMock.mock.calls[2][0];
    expect(secondQuery).toBeInstanceOf(QueryCommand);
    expect(secondQuery.input.ExclusiveStartKey).toEqual({ pncp_control_number: "pagina1-99" });
  });

  it("para de paginar assim que acumula NEW_COUNT_CAP matches pos-filtro, sem escanear paginas a mais", async () => {
    const savedSearch = buildSavedSearch({ criteria: { uf: ["GO"] } }); // sem keyword: tudo bate
    sendMock.mockResolvedValueOnce({ Item: savedSearch });
    sendMock.mockResolvedValueOnce({
      Items: nonMatchingTenders(100, "cheia"),
      LastEvaluatedKey: { pncp_control_number: "cheia-99" },
    });

    const result = await countNewMatchesForSavedSearch("acc-1", "ss-1");

    expect(result).toEqual({ found: true, new_count: 100 });
    // 1 GetCommand + so 1 QueryCommand -- ja bateu o teto na 1a pagina, nao precisa buscar a 2a
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("respeita o teto de leitura por requisicao quando ha muitos itens novos que nunca batem o filtro", async () => {
    const savedSearch = buildSavedSearch();
    sendMock.mockResolvedValueOnce({ Item: savedSearch });
    // 50 paginas de itens que nunca batem a keyword -- so as MAX_QUERIES_PER_REQUEST (40) primeiras
    // devem ser consultadas antes de o motor desistir e devolver a contagem parcial.
    for (let i = 0; i < 50; i++) {
      sendMock.mockResolvedValueOnce({
        Items: nonMatchingTenders(100, `p${i}`),
        LastEvaluatedKey: { pncp_control_number: `p${i}-99` },
      });
    }

    const result = await countNewMatchesForSavedSearch("acc-1", "ss-1");

    expect(result).toEqual({ found: true, new_count: 0 });
    // 1 GetCommand + no maximo 40 QueryCommand (teto de leitura de tender-query.ts)
    expect(sendMock).toHaveBeenCalledTimes(41);
  });

  it("soma matches de multiplos valores de uf num unico merge, lendo os streams em paralelo", async () => {
    const savedSearch = buildSavedSearch({ criteria: { uf: ["GO", "SP"] } });
    sendMock.mockResolvedValueOnce({ Item: savedSearch });
    sendMock.mockResolvedValueOnce({ Items: nonMatchingTenders(60, "go"), LastEvaluatedKey: undefined });
    sendMock.mockResolvedValueOnce({ Items: nonMatchingTenders(60, "sp"), LastEvaluatedKey: undefined });

    const result = await countNewMatchesForSavedSearch("acc-1", "ss-1");

    // 120 candidatos, teto de contagem em NEW_COUNT_CAP (100).
    expect(result).toEqual({ found: true, new_count: 100 });
    // 1 GetCommand + 1 QueryCommand por UF. Os dois streams sao lidos em paralelo de proposito: o
    // merge precisa do head de cada um pra saber qual item vem primeiro na ordenacao global.
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it("saved search inexistente/de outra conta devolve found:false sem consultar Tenders", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });

    const result = await countNewMatchesForSavedSearch("acc-1", "ss-inexistente");

    expect(result).toEqual({ found: false, new_count: 0 });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("createSavedSearch - teto e dedupe de criteria.uf/criteria.modalidade", () => {
  it("rejeita 'criteria.uf' acima do teto (MAX_MULTI_VALUES) com erro claro, sem gravar nada", async () => {
    const ufsAcimaDoTeto = ["GO", "SP", "MG", "RJ", "BA", "PR"]; // 6 > MAX_MULTI_VALUES (5)
    expect(ufsAcimaDoTeto.length).toBeGreaterThan(MAX_MULTI_VALUES);

    await expect(
      createSavedSearch("acc-1", { name: "Muitas UFs", criteria: { uf: ufsAcimaDoTeto } }),
    ).rejects.toThrow(HttpError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejeita 'criteria.modalidade' acima do teto (MAX_MULTI_VALUES) com erro claro, sem gravar nada", async () => {
    const modalidadesAcimaDoTeto = Array.from({ length: MAX_MULTI_VALUES + 1 }, (_, i) => `Modalidade ${i}`);

    await expect(
      createSavedSearch("acc-1", { name: "Muitas modalidades", criteria: { modalidade: modalidadesAcimaDoTeto } }),
    ).rejects.toThrow(HttpError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("deduplica valores repetidos de 'criteria.uf' silenciosamente, mantendo consistencia com a busca ad-hoc", async () => {
    sendMock.mockResolvedValueOnce({});

    const saved = await createSavedSearch("acc-1", { name: "UF duplicada", criteria: { uf: ["GO", "go", "GO"] } });

    expect(saved.criteria.uf).toEqual(["GO"]);
  });

  it("deduplica valores repetidos de 'criteria.modalidade' silenciosamente", async () => {
    sendMock.mockResolvedValueOnce({});

    const saved = await createSavedSearch("acc-1", {
      name: "Modalidade duplicada",
      criteria: { modalidade: ["Pregão - Eletrônico", "Pregão - Eletrônico"] },
    });

    expect(saved.criteria.modalidade).toEqual(["Pregão - Eletrônico"]);
  });
});
