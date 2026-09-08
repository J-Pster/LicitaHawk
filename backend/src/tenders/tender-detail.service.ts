import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { HttpError } from "../common/http-error";
import {
  CompraKey,
  arquivoDownloadUrl,
  fetchCompraArquivos,
  fetchCompraDetalhe,
  fetchCompraHistorico,
  fetchCompraItens,
  fetchItemResultados,
  parseControlNumber,
} from "./pncp-detail-client";
import { getTenderById } from "./tenders.service";
import { Tender } from "./tender.types";

const DETAILS_TABLE = "TenderDetails";

/**
 * Por quanto tempo o detalhe em cache e considerado fresco. Contratacao publicada muda pouco
 * (adendo, novo documento, resultado homologado), e o proprio detalhe carrega a data da ultima
 * alteracao no PNCP -- que e o gatilho preciso de revalidacao. Este prazo e so a rede de seguranca
 * para o caso de a data nao mudar mas o conteudo sim (arquivo novo, por exemplo).
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Um item do DynamoDB nao passa de 400 KB. Compra de registro de precos passa de mil itens, e cada
 * item do PNCP tem ~1 KB de JSON: sem teto, uma unica ata estouraria o limite e o PutItem falharia
 * inteiro, derrubando o detalhe todo por causa da cauda da lista. Guardamos o comeco e sinalizamos
 * o corte, em vez de perder tudo ou fingir que a lista esta completa.
 */
const MAX_ITENS_ARMAZENADOS = 250;
const MAX_HISTORICO_ARMAZENADO = 150;

/**
 * Teto de chamadas de resultado por contratacao. Resultado e por item, ou seja, uma requisicao
 * extra cada: sem teto, abrir uma ata com 800 itens dispararia 800 requisicoes ao PNCP numa unica
 * visita de tela.
 */
const MAX_ITENS_COM_RESULTADO = 60;

export interface TenderItem {
  numero: number;
  descricao: string;
  quantidade: number;
  unidade_medida: string;
  valor_unitario_estimado: number;
  valor_total: number;
  material_ou_servico: string;
  criterio_julgamento: string;
  situacao: string;
  tem_resultado: boolean;
  tipo_beneficio: string;
  ncm_nbs_codigo: string | null;
  informacao_complementar: string | null;
  resultados: TenderItemResult[];
}

export interface TenderItemResult {
  fornecedor_nome: string;
  fornecedor_ni: string;
  fornecedor_porte: string;
  fornecedor_natureza_juridica: string | null;
  valor_unitario_homologado: number | null;
  valor_total_homologado: number | null;
  quantidade_homologada: number | null;
  percentual_desconto: number | null;
  data_resultado: string | null;
  situacao: string | null;
  ordem_classificacao: number | null;
}

export interface TenderDocument {
  sequencial: number;
  titulo: string;
  tipo: string;
  data_publicacao: string;
  ativo: boolean;
  url: string;
}

export interface TenderHistoryEntry {
  data: string;
  tipo: string;
  categoria: string;
  usuario: string | null;
  documento_titulo: string | null;
  justificativa: string | null;
}

export interface TenderDetail {
  pncp_control_number: string;
  fetched_at: string;
  source_updated_at: string;
  /** Detalhe cru do PNCP: tudo que a API devolve, sem recorte, para nada se perder. */
  compra: Record<string, unknown>;
  itens: TenderItem[];
  itens_total: number;
  itens_truncados: boolean;
  resultados_truncados: boolean;
  documentos: TenderDocument[];
  historico: TenderHistoryEntry[];
  historico_truncado: boolean;
  /** Secoes que o PNCP nao entregou nesta busca (ex.: ["documentos"]). Vazio = detalhe completo. */
  secoes_indisponiveis: string[];
}

export interface FullTender extends Omit<Tender, "uf_modalidade"> {
  detail: TenderDetail | null;
  /** Preenchido quando o PNCP falhou e servimos apenas o que ja tinhamos indexado. */
  detail_error: string | null;
  /**
   * True quando ha detalhe a buscar mas esta resposta nao esperou por ele (`?detail=cached`).
   * O cliente usa isso para abrir a tela na hora com o que ja existe e pedir o detalhe completo
   * numa segunda chamada, em vez de encarar a espera do PNCP com a tela vazia.
   */
  detail_pending: boolean;
}

/**
 * Devolve a licitacao com TUDO que o PNCP publica sobre ela: dados da compra, itens, resultados
 * (fornecedor vencedor, valor homologado), documentos e historico de alteracoes.
 *
 * Estrategia: o detalhe e buscado sob demanda e persistido. Puxar isso na ingestao multiplicaria
 * por quatro ou mais o trafego contra o PNCP para milhares de licitacoes por dia, das quais quase
 * nenhuma seria aberta por alguem. Na primeira visita paga-se a busca (poucos segundos); da
 * segunda em diante vem do nosso banco.
 *
 * Revalidacao: se a licitacao indexada tem `data_atualizacao` mais nova que a do detalhe salvo,
 * o cache e considerado velho na hora, independente do TTL -- e assim que um resultado homologado
 * ou um documento novo aparece sem espera.
 */
export async function getFullTender(
  controlNumber: string,
  options: { refresh?: boolean; skipFetch?: boolean } = {},
): Promise<FullTender> {
  const stored = await getTenderById(controlNumber);
  if (!stored) {
    throw new HttpError(404, "tender nao encontrado", "NOT_FOUND");
  }
  // `uf_modalidade` e' chave de indice derivada (ver uf-modalidade-key.ts), nao dado do PNCP: fica
  // fora da resposta pra nao virar um campo publico que alguem passe a depender.
  const { uf_modalidade: _ufModalidade, ...tender } = stored;

  const key = parseControlNumber(controlNumber);
  if (!key) {
    // Indexado com um numero de controle fora do padrao do PNCP: ainda entregamos o que temos.
    return {
      ...tender,
      detail: null,
      detail_error: "numero de controle fora do padrao do PNCP",
      detail_pending: false,
    };
  }

  const cached = await readCachedDetail(controlNumber);
  // `refresh` existe porque o PNCP falha de forma intermitente: quando uma secao nao vem, a tela
  // mostra o que faltou e oferece tentar de novo, em vez de deixar o usuario preso a um detalhe
  // incompleto ate o cache expirar.
  if (cached && !options.refresh && isFresh(cached, stored)) {
    return { ...tender, detail: cached, detail_error: null, detail_pending: false };
  }

  // `skipFetch`: responde na hora com o que existe (cache velho ou nada) e avisa que falta buscar.
  // O PNCP leva de segundos a dezenas de segundos quando esta instavel; segurar a tela ate la
  // esconderia dados que ja temos indexados e sao uteis de imediato.
  if (options.skipFetch) {
    return { ...tender, detail: cached ?? null, detail_error: null, detail_pending: true };
  }

  try {
    const detail = await fetchDetailFromPncp(controlNumber, key);
    await writeCachedDetail(detail);
    return { ...tender, detail, detail_error: null, detail_pending: false };
  } catch (err) {
    // O PNCP cai com alguma frequencia. Servir o que ja temos (o proprio cache velho, se houver)
    // com o erro declarado e melhor do que derrubar a tela inteira de uma licitacao.
    return {
      ...tender,
      detail: cached ?? null,
      detail_error: (err as Error).message,
      detail_pending: false,
    };
  }
}

function valueOrDegrade<T>(
  settled: PromiseSettledResult<T[]>,
  indisponiveis: string[],
  secao: string,
): T[] {
  if (settled.status === "fulfilled") return settled.value;
  indisponiveis.push(secao);
  return [];
}

/**
 * Um detalhe que veio incompleto vale pouco tempo: a proxima visita tenta completar o que faltou,
 * em vez de carregar o buraco por seis horas.
 */
const CACHE_TTL_PARCIAL_MS = 10 * 60 * 1000;

function isFresh(cached: TenderDetail, tender: Tender): boolean {
  const indexedUpdatedAt = tender.data_atualizacao ?? "";
  if (indexedUpdatedAt && cached.source_updated_at && indexedUpdatedAt > cached.source_updated_at) {
    return false;
  }
  const ttl = (cached.secoes_indisponiveis ?? []).length > 0 ? CACHE_TTL_PARCIAL_MS : CACHE_TTL_MS;
  return Date.now() - Date.parse(cached.fetched_at) < ttl;
}

async function fetchDetailFromPncp(controlNumber: string, key: CompraKey): Promise<TenderDetail> {
  // Quatro chamadas independentes, em paralelo porque nenhuma depende da outra.
  //
  // allSettled, e nao all: o endpoint de arquivos do PNCP engasga com frequencia (comprovado com
  // curl, nao e o nosso cliente). Com `all`, um arquivo indisponivel derrubaria a licitacao
  // inteira, incluindo os itens e o resultado que ja tinham chegado. Cada secao que falha some da
  // resposta e e declarada em `secoes_indisponiveis`, o que a tela mostra honestamente em vez de
  // fingir que a licitacao nao tem documento nenhum.
  const [compraRes, itensRes, arquivosRes, historicoRes] = await Promise.allSettled([
    fetchCompraDetalhe(key),
    fetchCompraItens(key),
    fetchCompraArquivos(key),
    fetchCompraHistorico(key),
  ]);

  // A compra e a unica secao obrigatoria: sem ela nao ha detalhe nenhum a mostrar.
  if (compraRes.status === "rejected") {
    throw compraRes.reason instanceof Error ? compraRes.reason : new Error(String(compraRes.reason));
  }

  const indisponiveis: string[] = [];
  const compra = compraRes.value;
  const itensRaw = valueOrDegrade(itensRes, indisponiveis, "itens");
  const arquivosRaw = valueOrDegrade(arquivosRes, indisponiveis, "documentos");
  const historicoRaw = valueOrDegrade(historicoRes, indisponiveis, "historico");

  const itensParaResultado = itensRaw
    .filter((item) => item.temResultado === true)
    .slice(0, MAX_ITENS_COM_RESULTADO);

  const resultadosPorItem = new Map<number, TenderItemResult[]>();
  const resultados = await Promise.allSettled(
    itensParaResultado.map(async (item) => {
      const numero = Number(item.numeroItem ?? 0);
      return { numero, lista: mapResultados(await fetchItemResultados(key, numero)) };
    }),
  );
  for (const r of resultados) {
    if (r.status === "fulfilled") resultadosPorItem.set(r.value.numero, r.value.lista);
    else if (!indisponiveis.includes("resultados")) indisponiveis.push("resultados");
  }

  const itens = itensRaw
    .slice(0, MAX_ITENS_ARMAZENADOS)
    .map((raw) => mapItem(raw, resultadosPorItem.get(Number(raw.numeroItem ?? 0)) ?? []));

  return {
    pncp_control_number: controlNumber,
    fetched_at: new Date().toISOString(),
    source_updated_at: String(
      compra?.dataAtualizacaoGlobal ?? compra?.dataAtualizacao ?? "",
    ),
    compra: compra ?? {},
    itens,
    itens_total: itensRaw.length,
    itens_truncados: itensRaw.length > MAX_ITENS_ARMAZENADOS,
    resultados_truncados:
      itensRaw.filter((item) => item.temResultado === true).length > MAX_ITENS_COM_RESULTADO,
    documentos: arquivosRaw.map((raw) => mapDocumento(raw, key)),
    historico: historicoRaw.slice(0, MAX_HISTORICO_ARMAZENADO).map(mapHistorico),
    historico_truncado: historicoRaw.length > MAX_HISTORICO_ARMAZENADO,
    secoes_indisponiveis: indisponiveis,
  };
}

function mapItem(raw: Record<string, unknown>, resultados: TenderItemResult[]): TenderItem {
  return {
    numero: Number(raw.numeroItem ?? 0),
    descricao: String(raw.descricao ?? "").trim(),
    quantidade: Number(raw.quantidade ?? 0),
    unidade_medida: String(raw.unidadeMedida ?? ""),
    valor_unitario_estimado: Number(raw.valorUnitarioEstimado ?? 0),
    valor_total: Number(raw.valorTotal ?? 0),
    material_ou_servico: String(raw.materialOuServicoNome ?? ""),
    criterio_julgamento: String(raw.criterioJulgamentoNome ?? ""),
    situacao: String(raw.situacaoCompraItemNome ?? ""),
    tem_resultado: raw.temResultado === true,
    tipo_beneficio: String(raw.tipoBeneficioNome ?? ""),
    ncm_nbs_codigo: raw.ncmNbsCodigo ? String(raw.ncmNbsCodigo) : null,
    informacao_complementar: raw.informacaoComplementar ? String(raw.informacaoComplementar) : null,
    resultados,
  };
}

function mapResultados(raw: Record<string, unknown>[]): TenderItemResult[] {
  return raw.map((r) => ({
    fornecedor_nome: String(r.nomeRazaoSocialFornecedor ?? ""),
    fornecedor_ni: String(r.niFornecedor ?? ""),
    fornecedor_porte: String(r.porteFornecedorNome ?? ""),
    fornecedor_natureza_juridica: r.naturezaJuridicaNome ? String(r.naturezaJuridicaNome) : null,
    valor_unitario_homologado: toNumberOrNull(r.valorUnitarioHomologado),
    valor_total_homologado: toNumberOrNull(r.valorTotalHomologado),
    quantidade_homologada: toNumberOrNull(r.quantidadeHomologada),
    percentual_desconto: toNumberOrNull(r.percentualDesconto),
    data_resultado: r.dataResultado ? String(r.dataResultado) : null,
    situacao: r.situacaoCompraItemResultadoNome ? String(r.situacaoCompraItemResultadoNome) : null,
    ordem_classificacao: toNumberOrNull(r.ordemClassificacaoSrp),
  }));
}

function mapDocumento(raw: Record<string, unknown>, key: CompraKey): TenderDocument {
  const sequencial = Number(raw.sequencialDocumento ?? 0);
  return {
    sequencial,
    titulo: String(raw.titulo ?? "Documento"),
    tipo: String(raw.tipoDocumentoNome ?? ""),
    data_publicacao: String(raw.dataPublicacaoPncp ?? ""),
    ativo: raw.statusAtivo !== false,
    // A url que o PNCP devolve aponta para /pncp-api/...; montamos a partir da base atual para
    // nao depender de um caminho legado que ja mudou uma vez.
    url: arquivoDownloadUrl(key, sequencial),
  };
}

function mapHistorico(raw: Record<string, unknown>): TenderHistoryEntry {
  return {
    data: String(raw.logManutencaoDataInclusao ?? ""),
    tipo: String(raw.tipoLogManutencaoNome ?? ""),
    categoria: String(raw.categoriaLogManutencaoNome ?? ""),
    usuario: raw.usuarioNome ? String(raw.usuarioNome) : null,
    documento_titulo: raw.documentoTitulo ? String(raw.documentoTitulo) : null,
    justificativa: raw.justificativa ? String(raw.justificativa) : null,
  };
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function readCachedDetail(controlNumber: string): Promise<TenderDetail | null> {
  const res = await ddbDocClient.send(
    new GetCommand({ TableName: DETAILS_TABLE, Key: { pncp_control_number: controlNumber } }),
  );
  return (res.Item as TenderDetail | undefined) ?? null;
}

async function writeCachedDetail(detail: TenderDetail): Promise<void> {
  await ddbDocClient.send(new PutCommand({ TableName: DETAILS_TABLE, Item: detail }));
}
