import { recordRateLimitAttempt } from "./rate-limit-tracking";

/**
 * Cliente dos endpoints de DETALHE de uma contratacao do PNCP.
 *
 * Separado de pncp-client.ts de proposito: aquele serve a ingestao em massa (paginacao por
 * modalidade, com 1s de espera obrigatoria entre chamadas para nao estourar o rate limit do PNCP
 * ao varrer o pais inteiro). Este aqui roda sob demanda, quando alguem abre uma licitacao, e
 * precisa responder rapido -- por isso nao dorme entre chamadas e paraleliza o que da.
 *
 * As duas familias de endpoint que o PNCP expoe hoje, mapeadas contra a API real em 2026-09-08:
 *
 * | dado                | base              | caminho                                             |
 * |---------------------|-------------------|-----------------------------------------------------|
 * | detalhe da compra   | /api/consulta/v1  | /orgaos/{cnpj}/compras/{ano}/{seq}                   |
 * | itens               | /api/pncp/v1      | /orgaos/{cnpj}/compras/{ano}/{seq}/itens             |
 * | resultados do item  | /api/pncp/v1      | .../itens/{numeroItem}/resultados                    |
 * | arquivos            | /api/pncp/v1      | .../arquivos                                         |
 * | historico           | /api/pncp/v1      | .../historico                                        |
 *
 * O detalhe MUDOU de base: `/api/pncp/v1/orgaos/.../compras/...` hoje responde 301 apontando para
 * `/api/consulta/v1/...`. Como fetch nao segue redirect entre hosts/paths por padrao em toda
 * configuracao, apontamos direto para o destino final.
 */

const CONSULTA_BASE = "https://pncp.gov.br/api/consulta/v1";
const PNCP_BASE = "https://pncp.gov.br/api/pncp/v1";

// Headers da requisicao. O `accept` curinga nao e cosmetico: medido contra a API real, o endpoint
// de itens (/api/pncp/v1/.../itens) NAO responde quando o accept e "application/json", nem quando
// o header e omitido -- a conexao fica pendurada ate estourar o timeout. Com o curinga responde em
// ~50ms. E o mesmo valor que os exemplos em curl do manual oficial do PNCP usam.
// (Comentario de linha, e nao de bloco, porque o proprio valor do header fecharia o bloco.)
//
// O user-agent identifica o produto por boa cidadania: numa API publica, quem opera do outro lado
// consegue distinguir nosso trafego e falar com a gente se algo incomodar.
const REQUEST_HEADERS = {
  accept: "*/*",
  "user-agent": "LicitaHawk/1.0 (+https://licitahawk.com.br)",
};

// Timeout curto e mais tentativas, e nao o contrario. Medido contra a API real: quando o PNCP
// responde, responde em 50-500ms; quando engasga (o endpoint de arquivos faz isso com frequencia),
// a conexao fica pendurada indefinidamente e a tentativa seguinte costuma passar na hora. Esperar
// 12s por uma resposta que nunca vem so atrasa a unica coisa que resolve, que e tentar de novo.
const FETCH_TIMEOUT_MS = 4_000;
const MAX_RETRIES = 4;

export interface CompraKey {
  cnpj: string;
  ano: number;
  sequencial: number;
}

/**
 * Quebra o numero de controle do PNCP em CNPJ, ano e sequencial.
 *
 * Formato oficial: `CNPJ(14)-1-SEQUENCIAL(6)/ANO(4)`, por exemplo
 * `07533656000119-1-000134/2026`. O "1" fixo do meio e o marcador de "contratacao" no padrao do
 * PNCP; nao e dado nosso, so precisa estar la.
 *
 * Retorna null em vez de lancar: o id vem da URL, ou seja, de fora, e quem chama transforma isso
 * num 400 com mensagem propria.
 */
export function parseControlNumber(controlNumber: string): CompraKey | null {
  const match = /^(\d{14})-\d+-(\d+)\/(\d{4})$/.exec(controlNumber.trim());
  if (!match) return null;
  return { cnpj: match[1], sequencial: Number(match[2]), ano: Number(match[3]) };
}

function comprasPath(key: CompraKey): string {
  return `/orgaos/${key.cnpj}/compras/${key.ano}/${key.sequencial}`;
}

/**
 * GET com retry exponencial e registro de tentativa (mesma telemetria de rate limit da ingestao,
 * para o 429 do PNCP aparecer numa metrica so, venha de onde vier).
 *
 * 204 e 404 viram `null`: sao respostas legitimas ("essa compra nao tem resultado ainda", "nao ha
 * arquivos"), nao falha. Erro de verdade (5xx, rede, timeout) reentra no backoff e, esgotado,
 * lanca -- quem chama decide se degrada ou propaga.
 */
async function fetchPncpJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    let networkError: string | undefined;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: REQUEST_HEADERS,
      });
    } catch (err) {
      networkError = (err as Error).message;
    }

    const status = response?.status ?? null;
    await recordRateLimitAttempt({
      attempt: attempt + 1,
      modalidade: 0,
      endpoint: url,
      httpStatus: status,
      is429: status === 429,
      backoffDelayMs: 0,
    });

    if (response && (response.status === 204 || response.status === 404)) return null;
    if (response && response.status === 200) return (await response.json()) as T;

    if (attempt >= MAX_RETRIES) {
      throw new Error(
        `PNCP nao respondeu para ${url} apos ${MAX_RETRIES + 1} tentativas (${networkError ?? `status ${status}`})`,
      );
    }
    // Espacamento crescente ate 3s: medido contra a API real, a indisponibilidade do PNCP vem em
    // rajada (falhas correlacionadas por alguns segundos, nao sorteadas de forma independente),
    // entao tentativas coladas caem todas na mesma janela ruim.
    await sleep(Math.min(3000, 300 * 2 ** attempt));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fetchCompraDetalhe(key: CompraKey): Promise<Record<string, unknown> | null> {
  return fetchPncpJson<Record<string, unknown>>(`${CONSULTA_BASE}${comprasPath(key)}`);
}

export async function fetchCompraItens(key: CompraKey): Promise<Record<string, unknown>[]> {
  return (await fetchPncpJson<Record<string, unknown>[]>(`${PNCP_BASE}${comprasPath(key)}/itens`)) ?? [];
}

export async function fetchCompraArquivos(key: CompraKey): Promise<Record<string, unknown>[]> {
  return (await fetchPncpJson<Record<string, unknown>[]>(`${PNCP_BASE}${comprasPath(key)}/arquivos`)) ?? [];
}

export async function fetchCompraHistorico(key: CompraKey): Promise<Record<string, unknown>[]> {
  return (await fetchPncpJson<Record<string, unknown>[]>(`${PNCP_BASE}${comprasPath(key)}/historico`)) ?? [];
}

export async function fetchItemResultados(
  key: CompraKey,
  numeroItem: number,
): Promise<Record<string, unknown>[]> {
  return (
    (await fetchPncpJson<Record<string, unknown>[]>(
      `${PNCP_BASE}${comprasPath(key)}/itens/${numeroItem}/resultados`,
    )) ?? []
  );
}

/** URL publica de download de um arquivo da contratacao (o PNCP serve o binario direto). */
export function arquivoDownloadUrl(key: CompraKey, sequencialDocumento: number): string {
  return `${PNCP_BASE}${comprasPath(key)}/arquivos/${sequencialDocumento}`;
}
