import { HttpError } from "./http-error";
import { assertValidModalidadeNome } from "./modalidades";

// Helpers de validacao de query param reusados pelas rotas de tenders e filtros. Centralizados
// aqui pra evitar duplicar a mesma regra (ex.: lista de UFs validas) em mais de um router, e pra
// garantir mensagem de erro + codigo consistentes em toda a API.

const VALID_UFS = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR",
  "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

export const MAX_MULTI_VALUES = 5;

export function assertValidUf(uf: string): void {
  if (!VALID_UFS.has(uf.toUpperCase())) {
    throw new HttpError(
      400,
      `UF invalida: '${uf}'. Use uma sigla de 2 letras (ex.: GO, SP).`,
      "VALIDATION_ERROR",
    );
  }
}

/** Aceita lista separada por virgula (ex. "GO,SP,MG"), ate MAX_MULTI_VALUES valores. */
export function parseUfList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = [...new Set(raw.split(",").map((v) => v.trim().toUpperCase()).filter(Boolean))];
  if (values.length === 0) return undefined;
  if (values.length > MAX_MULTI_VALUES) {
    throw new HttpError(400, `no maximo ${MAX_MULTI_VALUES} UFs por requisicao`, "VALIDATION_ERROR");
  }
  values.forEach(assertValidUf);
  return values;
}

/**
 * Ate 2026-09-08 `modalidade` era texto livre aqui de proposito (so as rotas de webhook validavam
 * contra o dominio). Isso era um filtro morto silencioso: `Tender.modalidade` guarda o
 * `modalidadeNome` cru do PNCP e a Query e' por igualdade EXATA de string, entao "pregao eletronico"
 * (sem acento, sem hifen) nunca casava com nada e a API respondia 200 com lista vazia -- indistin-
 * guivel de "nao ha licitacao nesse recorte". Agora vale a mesma regra do resto do produto (a
 * invariante do CLAUDE.md): modalidade casa por igualdade exata contra a tabela de dominio, entao
 * valor fora dela e' 400 com a lista dos valores aceitos.
 */
export function parseModalidadeList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))];
  if (values.length === 0) return undefined;
  if (values.length > MAX_MULTI_VALUES) {
    throw new HttpError(400, `no maximo ${MAX_MULTI_VALUES} modalidades por requisicao`, "VALIDATION_ERROR");
  }
  values.forEach(assertValidModalidadeNome);
  return values;
}

/**
 * Situacao da contratacao (`situacaoCompraNome` do PNCP, ex. "Divulgada no PNCP", "Revogada").
 * Diferente de modalidade, NAO ha tabela de dominio estavel publicada -- entao aqui a validacao e'
 * so de forma (nao-vazio, teto de valores) e o casamento e' case/acento-insensitive em memoria
 * (ver tenders.service.ts::buildTenderFilter), pra que "revogada" ache "Revogada".
 */
export function parseSituacaoList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))];
  if (values.length === 0) return undefined;
  if (values.length > MAX_MULTI_VALUES) {
    throw new HttpError(400, `no maximo ${MAX_MULTI_VALUES} situacoes por requisicao`, "VALIDATION_ERROR");
  }
  return values;
}

/**
 * Achado real: `Number(limit)` de um valor invalido (ex. "abc", negativo, 0) vira NaN/valor
 * fora de faixa e era passado direto pro `Limit` do DynamoDB QueryCommand sem validacao --
 * comportamento indefinido (a lib do SDK rejeita ou o Local se comporta de forma inconsistente).
 */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 20;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new HttpError(400, "'limit' deve ser um inteiro entre 1 e 100", "VALIDATION_ERROR");
  }
  return n;
}

/**
 * Teto do PRODUTO cartesiano uf x modalidade. Cada par vira uma partition key propria em GSI4 e,
 * portanto, um QueryCommand por pagina de resposta: sem esse teto, 5 UFs x 5 modalidades = 25
 * Queries paralelas por clique de "carregar mais". O teto e' menor que MAX_MULTI_VALUES ao quadrado
 * de proposito -- e' o custo real por requisicao que importa, nao quantos valores cabem em cada
 * campo isoladamente.
 */
export const MAX_QUERY_TARGETS = 12;

/**
 * Regra compartilhada por qualquer criterio de busca sobre Tenders via GSI (busca ao vivo em
 * tenders.service.ts::searchTenders e criterio salvo em account/saved-searches.service.ts): exige
 * uf OU modalidade OU os dois -- nunca nenhum dos dois, porque sem partition key nao ha GSI pra
 * consultar e Scan na tabela inteira e' proibido.
 *
 * Ate 2026-09-08 esta regra era um XOR ("nunca os dois juntos"), o que nao era decisao de produto e
 * sim o formato dos indices vazando pra API: `Tenders` so tinha GSI de uf e GSI de modalidade
 * separados, e o DynamoDB nao intersecta dois indices. Com a chave composta `uf_modalidade` (GSI4,
 * ver tender-query.ts) a combinacao virou uma Query exata como qualquer outra.
 */
export function assertUfOrModalidade(ufList: string[], modalidadeList: string[]): void {
  if (ufList.length === 0 && modalidadeList.length === 0) {
    throw new HttpError(400, "informe 'uf' e/ou 'modalidade' (nunca fazemos Scan na tabela inteira)", "VALIDATION_ERROR");
  }
  const targets = ufList.length > 0 && modalidadeList.length > 0
    ? ufList.length * modalidadeList.length
    : Math.max(ufList.length, modalidadeList.length);
  if (targets > MAX_QUERY_TARGETS) {
    throw new HttpError(
      400,
      `a combinacao de 'uf' e 'modalidade' gera ${targets} consultas de indice (teto: ${MAX_QUERY_TARGETS}) -- reduza a quantidade de UFs ou de modalidades`,
      "VALIDATION_ERROR",
    );
  }
}

export type SortOrder = "asc" | "desc";

export function parseSort(raw: string | undefined): SortOrder {
  if (raw === undefined) return "desc";
  if (raw !== "asc" && raw !== "desc") {
    throw new HttpError(400, "'sort' deve ser 'asc' ou 'desc'", "VALIDATION_ERROR");
  }
  return raw;
}

export interface DateRange {
  dataInicial?: string;
  dataFinal?: string;
}

/**
 * Antes, informar so um dos dois (dataInicial OU dataFinal) era silenciosamente ignorado
 * (hasDateRange exige os dois) -- o cliente recebia todos os resultados sem entender por que o
 * filtro de data nao surtiu efeito. Agora e' 400 explicito.
 */
export function parseDateRange(dataInicial: string | undefined, dataFinal: string | undefined): DateRange {
  if (!dataInicial && !dataFinal) return {};
  if (!dataInicial || !dataFinal) {
    throw new HttpError(
      400,
      "'dataInicial' e 'dataFinal' devem ser informados juntos",
      "VALIDATION_ERROR",
    );
  }
  const di = new Date(dataInicial);
  const df = new Date(dataFinal);
  if (Number.isNaN(di.getTime()) || Number.isNaN(df.getTime())) {
    throw new HttpError(400, "'dataInicial'/'dataFinal' devem ser datas ISO 8601 validas", "VALIDATION_ERROR");
  }
  if (di.getTime() > df.getTime()) {
    throw new HttpError(400, "'dataInicial' nao pode ser posterior a 'dataFinal'", "VALIDATION_ERROR");
  }
  return { dataInicial, dataFinal };
}

export interface ValorRange {
  valorMin?: number;
  valorMax?: number;
}

export function parseValorRange(valorMin: string | undefined, valorMax: string | undefined): ValorRange {
  const min = valorMin !== undefined ? Number(valorMin) : undefined;
  const max = valorMax !== undefined ? Number(valorMax) : undefined;
  if (min !== undefined && (Number.isNaN(min) || min < 0)) {
    throw new HttpError(400, "'valorMin' deve ser um numero >= 0", "VALIDATION_ERROR");
  }
  if (max !== undefined && (Number.isNaN(max) || max < 0)) {
    throw new HttpError(400, "'valorMax' deve ser um numero >= 0", "VALIDATION_ERROR");
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new HttpError(400, "'valorMin' nao pode ser maior que 'valorMax'", "VALIDATION_ERROR");
  }
  return { valorMin: min, valorMax: max };
}

export function assertValidWebhookUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError(
      400,
      "'webhook_url' deve ser uma URL valida (ex.: https://seu-servico.com/webhook)",
      "VALIDATION_ERROR",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "'webhook_url' deve usar http ou https", "VALIDATION_ERROR");
  }
}

/** Chave estavel pra cache/dedupe -- mesma combinacao de params gera a mesma chave independente da ordem. */
export function stableParamsKey(params: Record<string, unknown>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}
