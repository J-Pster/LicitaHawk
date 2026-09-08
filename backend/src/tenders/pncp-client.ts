import { Tender } from "./tender.types";
import { recordRateLimitAttempt } from "./rate-limit-tracking";
import { ufModalidadeKey } from "./uf-modalidade-key";

const BASE_URL = "https://pncp.gov.br/api/consulta/v1/contratacoes";

// Codigos validos de codigoModalidadeContratacao confirmados empiricamente contra a API real em 2026-09-06
// (nao documentados no OpenAPI, que so declara o parametro como obrigatorio sem listar o dominio).
// Atencao: a API rejeita com 422 "Periodo inicial e final maior que 365 dias" quando a janela de
// datas excede um ano -- esse erro e sobre o range de datas, nao sobre o codigo de modalidade.
export const MODALIDADE_CODES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

const MIN_DELAY_MS = 1000;
const MAX_RETRIES = 5;
const PAGE_SIZE = 50; // limite maximo documentado no OpenAPI (/v1/contratacoes/*): tamanhoPagina max=50
// Achado real da Rodada 6 (verificacao/testes): fetch() sem timeout ficava sujeito ao timeout
// default do undici (minutos) se o PNCP aceitasse a conexao e nunca respondesse -- com ate 6
// tentativas por modalidade x 15 modalidades sequenciais, um unico job de ingestao podia ultrapassar
// o intervalo de 15min do cron (scheduler.ts nao tem guarda contra sobreposicao), multiplicando a
// taxa de requests contra o PNCP acima do 1 req/s pretendido. AbortSignal.timeout trata o estouro
// como erro de rede (mesmo catch existente), reentra no backoff normal.
const FETCH_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PncpPage {
  data: Record<string, unknown>[];
  totalPaginas: number;
  numeroPagina: number;
}

/**
 * Busca uma pagina de contratacoes por data de atualizacao global (pega tanto publicacoes novas
 * quanto atualizacoes de contratacoes existentes) para uma modalidade especifica.
 * dataInicial/dataFinal no formato YYYYMMDD (unica granularidade aceita pela API).
 */
export async function fetchContratacoesAtualizacaoPage(
  dataInicial: string,
  dataFinal: string,
  codigoModalidadeContratacao: number,
  pagina: number,
): Promise<PncpPage | null> {
  const url = new URL(`${BASE_URL}/atualizacao`);
  url.searchParams.set("dataInicial", dataInicial);
  url.searchParams.set("dataFinal", dataFinal);
  url.searchParams.set("codigoModalidadeContratacao", String(codigoModalidadeContratacao));
  url.searchParams.set("pagina", String(pagina));
  url.searchParams.set("tamanhoPagina", String(PAGE_SIZE));
  const endpoint = url.toString();

  let attempt = 0;
  for (;;) {
    let response: Response | undefined;
    let networkErrorMessage: string | undefined;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      networkErrorMessage = (err as Error).message;
    } finally {
      await sleep(MIN_DELAY_MS);
    }

    if (!response) {
      attempt = await backoffOrThrow(attempt, `erro de rede em ${url}: ${networkErrorMessage}`, {
        modalidade: codigoModalidadeContratacao,
        endpoint,
        httpStatus: null,
        is429: false,
      });
      continue;
    }

    if (response.status === 204) {
      // 204 = sem resultados para essa combinacao de modalidade/janela/pagina -- fim legitimo, nao e erro.
      await track(attempt + 1, codigoModalidadeContratacao, endpoint, 204, false, 0);
      return null;
    }

    if (response.status === 200) {
      await track(attempt + 1, codigoModalidadeContratacao, endpoint, 200, false, 0);
      const body = (await response.json()) as PncpPage;
      return body;
    }

    if (response.status === 422) {
      await track(attempt + 1, codigoModalidadeContratacao, endpoint, 422, false, 0);
      throw new Error(`PNCP retornou 422 (parametro invalido) para ${url}`);
    }

    attempt = await backoffOrThrow(attempt, `PNCP retornou status ${response.status} para ${url}`, {
      modalidade: codigoModalidadeContratacao,
      endpoint,
      httpStatus: response.status,
      is429: response.status === 429,
    });
  }
}

interface BackoffTrackingCtx {
  modalidade: number;
  endpoint: string;
  httpStatus: number | null;
  is429: boolean;
}

function track(
  attempt: number,
  modalidade: number,
  endpoint: string,
  httpStatus: number | null,
  is429: boolean,
  backoffDelayMs: number,
): Promise<void> {
  // rate-limit tracking (rodada de observabilidade, ver PLAN.md e rate-limit-tracking.ts):
  // registra CADA tentativa (sucesso ou falha), nao so 429 -- e' o que permite calcular taxa de
  // 429 sobre total de requests depois, nao so contar 429 isolado.
  return recordRateLimitAttempt({ attempt, modalidade, endpoint, httpStatus, is429, backoffDelayMs });
}

async function backoffOrThrow(attempt: number, message: string, ctx: BackoffTrackingCtx): Promise<number> {
  if (attempt >= MAX_RETRIES) {
    await track(attempt + 1, ctx.modalidade, ctx.endpoint, ctx.httpStatus, ctx.is429, 0);
    throw new Error(`Excedeu ${MAX_RETRIES} tentativas: ${message}`);
  }
  const delayMs = Math.min(30_000, 1000 * 2 ** attempt);
  console.warn(`[pncp-client] ${message} -- tentativa ${attempt + 1}/${MAX_RETRIES}, aguardando ${delayMs}ms`);
  await track(attempt + 1, ctx.modalidade, ctx.endpoint, ctx.httpStatus, ctx.is429, delayMs);
  await sleep(delayMs);
  return attempt + 1;
}

/**
 * Normaliza um item bruto do payload do PNCP (RecuperarCompraPublicacaoDTO) para o schema
 * limpo de Tender usado internamente. Campos ausentes viram string vazia / 0, nunca lancam erro
 * (Risco #2 do PLAN.md: schema do PNCP pode mudar sem aviso).
 */
export function normalizeTender(raw: Record<string, unknown>): Tender {
  const orgao = (raw.orgaoEntidade ?? {}) as Record<string, unknown>;
  const unidade = (raw.unidadeOrgao ?? {}) as Record<string, unknown>;

  const cnpj = String(orgao.cnpj ?? "");
  const ano = raw.anoCompra ?? "";
  const sequencial = raw.sequencialCompra ?? "";
  const uf = String(unidade.ufSigla ?? "");
  const modalidade = String(raw.modalidadeNome ?? "");

  return {
    pncp_control_number: String(raw.numeroControlePNCP ?? ""),
    org_cnpj: cnpj,
    org_name: String(orgao.razaoSocial ?? ""),
    uf,
    municipio: String(unidade.municipioNome ?? ""),
    modalidade,
    // Chave derivada -- unico lugar que a escreve. Ver uf-modalidade-key.ts.
    uf_modalidade: ufModalidadeKey(uf, modalidade),
    objeto: String(raw.objetoCompra ?? ""),
    valor_estimado: Number(raw.valorTotalEstimado ?? 0),
    data_publicacao: String(raw.dataPublicacaoPncp ?? ""),
    data_atualizacao: String(raw.dataAtualizacaoGlobal ?? raw.dataAtualizacao ?? ""),
    situacao: String(raw.situacaoCompraNome ?? ""),
    link_pncp: `https://pncp.gov.br/app/editais/${cnpj}/${ano}/${sequencial}`,
    keywords_tokenized: tokenize(String(raw.objetoCompra ?? "")),
    raw_payload: raw,
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}
