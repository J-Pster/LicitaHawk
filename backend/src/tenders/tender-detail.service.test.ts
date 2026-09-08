import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFullTender } from "./tender-detail.service";

const ddbSend = vi.fn();
vi.mock("../common/dynamodb-client", () => ({ ddbDocClient: { send: (...args: unknown[]) => ddbSend(...args) } }));

const getTenderById = vi.fn();
vi.mock("./tenders.service", () => ({ getTenderById: (...args: unknown[]) => getTenderById(...args) }));

const fetchCompraDetalhe = vi.fn();
const fetchCompraItens = vi.fn();
const fetchCompraArquivos = vi.fn();
const fetchCompraHistorico = vi.fn();
const fetchItemResultados = vi.fn();
vi.mock("./pncp-detail-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./pncp-detail-client")>();
  return {
    ...real, // parseControlNumber e arquivoDownloadUrl sao puros: usamos os de verdade
    fetchCompraDetalhe: (...a: unknown[]) => fetchCompraDetalhe(...a),
    fetchCompraItens: (...a: unknown[]) => fetchCompraItens(...a),
    fetchCompraArquivos: (...a: unknown[]) => fetchCompraArquivos(...a),
    fetchCompraHistorico: (...a: unknown[]) => fetchCompraHistorico(...a),
    fetchItemResultados: (...a: unknown[]) => fetchItemResultados(...a),
  };
});



const CONTROL = "07533656000119-1-000134/2026";

const tenderIndexado = {
  pncp_control_number: CONTROL,
  org_cnpj: "07533656000119",
  org_name: "MUNICIPIO DE SAO GONCALO DO AMARANTE",
  uf: "CE",
  municipio: "Sao Goncalo do Amarante",
  modalidade: "Concorrência - Eletrônica",
  uf_modalidade: "GO#Concorrência - Eletrônica",
  objeto: "Obra",
  valor_estimado: 284046.77,
  data_publicacao: "2026-08-28T12:37:53",
  data_atualizacao: "2026-08-31T10:26:08",
  situacao: "Divulgada no PNCP",
  link_pncp: "https://pncp.gov.br/app/editais/07533656000119/2026/134",
  keywords_tokenized: ["obra"],
  raw_payload: {},
};

/** Respostas do DynamoDB: primeiro Get (cache), depois Put (gravacao). */
function mockDynamo(cachedItem: unknown) {
  ddbSend.mockReset();
  ddbSend.mockImplementation((command: { constructor: { name: string } }) => {
    if (command.constructor.name === "GetCommand") return Promise.resolve({ Item: cachedItem });
    return Promise.resolve({});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getTenderById.mockResolvedValue(tenderIndexado);
  fetchCompraDetalhe.mockResolvedValue({ objetoCompra: "Obra", dataAtualizacaoGlobal: "2026-08-31T10:26:08" });
  fetchCompraItens.mockResolvedValue([]);
  fetchCompraArquivos.mockResolvedValue([]);
  fetchCompraHistorico.mockResolvedValue([]);
  fetchItemResultados.mockResolvedValue([]);
  mockDynamo(undefined);
});

describe("getFullTender", () => {
  it("404 quando a licitacao nao esta indexada", async () => {
    getTenderById.mockResolvedValue(undefined);
    await expect(getFullTender(CONTROL)).rejects.toMatchObject({ status: 404 });
  });

  it("busca no PNCP e devolve itens, documentos, historico e resultados", async () => {
    fetchCompraItens.mockResolvedValue([
      { numeroItem: 1, descricao: " Notebook ", quantidade: 2, valorUnitarioEstimado: 5000, valorTotal: 10000, temResultado: true, unidadeMedida: "UN" },
    ]);
    fetchItemResultados.mockResolvedValue([
      { nomeRazaoSocialFornecedor: "ACME LTDA", niFornecedor: "31205225000108", valorTotalHomologado: 9000, quantidadeHomologada: 2 },
    ]);
    fetchCompraArquivos.mockResolvedValue([
      { sequencialDocumento: 1, titulo: "Edital", tipoDocumentoNome: "Edital", dataPublicacaoPncp: "2026-08-28T12:37:53", statusAtivo: true },
    ]);
    fetchCompraHistorico.mockResolvedValue([
      { logManutencaoDataInclusao: "2026-08-28T12:37:53", tipoLogManutencaoNome: "Inclusão", categoriaLogManutencaoNome: "Contratação", usuarioNome: "Fulano" },
    ]);

    const full = await getFullTender(CONTROL);

    expect(full.detail_error).toBeNull();
    expect(full.detail?.itens).toHaveLength(1);
    expect(full.detail?.itens[0].descricao).toBe("Notebook"); // trim aplicado
    expect(full.detail?.itens[0].resultados[0]).toMatchObject({
      fornecedor_nome: "ACME LTDA",
      valor_total_homologado: 9000,
    });
    expect(full.detail?.documentos[0].url).toContain("/arquivos/1");
    expect(full.detail?.historico).toHaveLength(1);
    expect(full.detail?.secoes_indisponiveis).toEqual([]);
  });

  it("so pede resultado de item que declara ter resultado", async () => {
    fetchCompraItens.mockResolvedValue([
      { numeroItem: 1, temResultado: false },
      { numeroItem: 2, temResultado: true },
    ]);
    await getFullTender(CONTROL);
    expect(fetchItemResultados).toHaveBeenCalledTimes(1);
    expect(fetchItemResultados).toHaveBeenCalledWith(expect.anything(), 2);
  });

  it("uma secao indisponivel nao derruba o resto do detalhe", async () => {
    // O endpoint de arquivos do PNCP engasga com frequencia: o resto tem que sobreviver.
    fetchCompraArquivos.mockRejectedValue(new Error("timeout"));
    fetchCompraItens.mockResolvedValue([{ numeroItem: 1, descricao: "Item", temResultado: false }]);

    const full = await getFullTender(CONTROL);

    expect(full.detail_error).toBeNull();
    expect(full.detail?.itens).toHaveLength(1);
    expect(full.detail?.documentos).toEqual([]);
    expect(full.detail?.secoes_indisponiveis).toContain("documentos");
  });

  it("falha na compra em si degrada para o cache antigo, com o erro declarado", async () => {
    const cacheAntigo = {
      pncp_control_number: CONTROL,
      fetched_at: "2020-01-01T00:00:00.000Z",
      source_updated_at: "2020-01-01T00:00:00",
      compra: { objetoCompra: "Versao antiga" },
      itens: [],
      itens_total: 0,
      itens_truncados: false,
      resultados_truncados: false,
      documentos: [],
      historico: [],
      historico_truncado: false,
      secoes_indisponiveis: [],
    };
    mockDynamo(cacheAntigo);
    fetchCompraDetalhe.mockRejectedValue(new Error("PNCP fora do ar"));

    const full = await getFullTender(CONTROL);

    expect(full.detail_error).toContain("PNCP fora do ar");
    expect(full.detail?.compra).toEqual({ objetoCompra: "Versao antiga" });
  });

  it("cache fresco evita qualquer chamada ao PNCP", async () => {
    mockDynamo({
      pncp_control_number: CONTROL,
      fetched_at: new Date().toISOString(),
      source_updated_at: "2026-08-31T10:26:08",
      compra: { objetoCompra: "Obra" },
      itens: [],
      itens_total: 0,
      itens_truncados: false,
      resultados_truncados: false,
      documentos: [],
      historico: [],
      historico_truncado: false,
      secoes_indisponiveis: [],
    });

    await getFullTender(CONTROL);

    expect(fetchCompraDetalhe).not.toHaveBeenCalled();
  });

  it("cache com data mais velha que a licitacao indexada e revalidado na hora", async () => {
    // Resultado homologado publicado depois: a data de atualizacao do indice avanca e o detalhe
    // precisa ser buscado de novo mesmo dentro do TTL.
    mockDynamo({
      pncp_control_number: CONTROL,
      fetched_at: new Date().toISOString(),
      source_updated_at: "2026-08-01T00:00:00",
      compra: {},
      itens: [],
      itens_total: 0,
      itens_truncados: false,
      resultados_truncados: false,
      documentos: [],
      historico: [],
      historico_truncado: false,
      secoes_indisponiveis: [],
    });

    await getFullTender(CONTROL);

    expect(fetchCompraDetalhe).toHaveBeenCalled();
  });

  it("refresh ignora o cache fresco e busca de novo", async () => {
    mockDynamo({
      pncp_control_number: CONTROL,
      fetched_at: new Date().toISOString(),
      source_updated_at: "2026-08-31T10:26:08",
      compra: {},
      itens: [],
      itens_total: 0,
      itens_truncados: false,
      resultados_truncados: false,
      documentos: [],
      historico: [],
      historico_truncado: false,
      secoes_indisponiveis: [],
    });

    await getFullTender(CONTROL, { refresh: true });

    expect(fetchCompraDetalhe).toHaveBeenCalled();
  });

  it("numero de controle fora do padrao devolve a licitacao indexada sem detalhe", async () => {
    getTenderById.mockResolvedValue({ ...tenderIndexado, pncp_control_number: "formato-estranho" });
    const full = await getFullTender("formato-estranho");
    expect(full.detail).toBeNull();
    expect(full.detail_error).toContain("fora do padrao");
    expect(fetchCompraDetalhe).not.toHaveBeenCalled();
  });
});
