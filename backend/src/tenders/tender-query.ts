import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { HttpError } from "../common/http-error";
import type { SortOrder } from "../common/query-validation";
import { TenderListItem } from "./tender.types";

export const TENDERS_TABLE = "Tenders";

export const TENDER_INDEX = {
  UF: "GSI1-uf-data_publicacao",
  MODALIDADE: "GSI2-modalidade-data_publicacao",
  ORG_CNPJ: "GSI3-org_cnpj-data_publicacao",
  UF_MODALIDADE: "GSI4-uf_modalidade-data_publicacao",
} as const;

/** Um "stream" de leitura: uma partition key concreta dentro de um GSI concreto. */
export interface QueryTarget {
  readonly id: string;
  readonly indexName: string;
  readonly pkName: string;
  readonly pkValue: string;
}

/**
 * Todos os campos de Tender EXCETO `raw_payload` (o payload cru do PNCP, dezenas de KB por item).
 * Nenhuma rota de LISTA devolve raw_payload -- so o detalhe (GET /v1/tenders/{id}, que faz GetItem
 * pela PK) precisa dele. Projetar explicitamente corta o trafego DynamoDB->API->cliente de uma
 * pagina de busca em ordem de grandeza, sem mudar nada que a OpenAPI documente (raw_payload nunca
 * esteve no schema `Tender`).
 */
const LIST_PROJECTED_FIELDS = [
  "pncp_control_number",
  "org_cnpj",
  "org_name",
  "uf",
  "municipio",
  "modalidade",
  "objeto",
  "valor_estimado",
  "data_publicacao",
  "data_atualizacao",
  "situacao",
  "link_pncp",
  "keywords_tokenized",
] as const;

const PROJECTION_NAMES: Record<string, string> = Object.fromEntries(
  LIST_PROJECTED_FIELDS.map((field, i) => [`#p${i}`, field]),
);
const PROJECTION_EXPRESSION = Object.keys(PROJECTION_NAMES).join(", ");

/**
 * Itens brutos lidos por QueryCommand. Maior que o `limit` do cliente de proposito: os filtros de
 * keyword/valor/municipio/situacao rodam em memoria DEPOIS da leitura, entao uma pagina bruta
 * pequena renderia pouquissimos matches e forcaria varias idas ao DynamoDB por pagina de resposta.
 */
const FETCH_PAGE_SIZE = 100;

/**
 * Teto de QueryCommands por requisicao HTTP. Existe porque uma busca com filtro muito seletivo
 * (ex.: keyword rara numa UF grande) pode varrer muita coisa antes de juntar `limit` matches --
 * sem teto, um unico GET poderia ler a particao inteira. Ao bater o teto devolvemos a pagina curta
 * COM `next_cursor` (nunca silenciosamente "acabou"), e `partial: true` diz que a pagina veio curta
 * por custo, nao por fim de dados.
 */
const MAX_QUERIES_PER_REQUEST = 40;

const CURSOR_VERSION = 2;

interface CursorState {
  v: number;
  /** target.id -> ExclusiveStartKey do ultimo item CONSUMIDO daquele stream. */
  k: Record<string, Record<string, unknown>>;
  /** target.ids ja drenados por completo -- nao vale a pena reconsultar. */
  x: string[];
}

interface DecodedCursor {
  keys: Record<string, Record<string, unknown>>;
  exhausted: Set<string>;
}

function invalidCursor(): never {
  throw new HttpError(400, "cursor de paginacao invalido", "VALIDATION_ERROR");
}

function decodeCursor(cursor: string | undefined, targets: readonly QueryTarget[]): DecodedCursor {
  if (!cursor) return { keys: {}, exhausted: new Set() };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    // Achado real: antes, um cursor invalido vindo do cliente (?cursor=lixo) derrubava o processo
    // inteiro via excecao nao tratada. Agora vira 400 controlado.
    invalidCursor();
  }
  if (typeof parsed !== "object" || parsed === null) invalidCursor();

  const state = parsed as Partial<CursorState>;
  if (state.v !== CURSOR_VERSION) {
    // Cursor v1 (formato antigo: o proprio ExclusiveStartKey, sem envelope) so fazia sentido com um
    // unico stream. Aceito por compatibilidade nesse caso; com varios streams e' ambiguo e vira 400.
    if (targets.length !== 1) invalidCursor();
    return { keys: { [targets[0].id]: parsed as Record<string, unknown> }, exhausted: new Set() };
  }

  const keys = state.k;
  if (typeof keys !== "object" || keys === null) invalidCursor();
  return { keys: keys as Record<string, Record<string, unknown>>, exhausted: new Set(state.x ?? []) };
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

interface Stream {
  target: QueryTarget;
  buffer: TenderListItem[];
  startKey: Record<string, unknown> | undefined;
  hasMorePages: boolean;
  exhausted: boolean;
  lastConsumedKey: Record<string, unknown> | undefined;
}

export interface MergedQueryParams {
  targets: readonly QueryTarget[];
  limit: number;
  sort: SortOrder;
  dataInicial?: string;
  dataFinal?: string;
  cursor?: string;
  /** Filtros que o GSI nao sabe aplicar (keyword, faixa de valor, municipio, situacao). */
  accept?: (tender: TenderListItem) => boolean;
}

export interface MergedQueryResult {
  data: TenderListItem[];
  next_cursor?: string;
  has_more: boolean;
  partial: boolean;
}

/**
 * Ordem de merge entre os heads dos streams: `data_publicacao` na direcao pedida, desempatando por
 * `pncp_control_number` pra que a ordem seja deterministica (dois tenders publicados no mesmo
 * instante em UFs diferentes nao podem alternar de posicao entre duas execucoes da mesma busca).
 */
function isAhead(a: TenderListItem, b: TenderListItem, sort: SortOrder): boolean {
  const byDate = a.data_publicacao.localeCompare(b.data_publicacao);
  if (byDate !== 0) return sort === "asc" ? byDate < 0 : byDate > 0;
  return a.pncp_control_number.localeCompare(b.pncp_control_number) < 0;
}

/**
 * Le UMA pagina bruta de um stream e a acumula no buffer dele.
 *
 * `Limit` do DynamoDB e' aplicado ANTES de qualquer filtro -- por isso os filtros de keyword/valor
 * NAO viram FilterExpression aqui: eles rodam em memoria no laco de merge, que continua puxando
 * paginas ate juntar `limit` matches de verdade.
 */
async function fetchPage(stream: Stream, params: MergedQueryParams): Promise<void> {
  const hasDateRange = Boolean(params.dataInicial && params.dataFinal);
  const res = await ddbDocClient.send(
    new QueryCommand({
      TableName: TENDERS_TABLE,
      IndexName: stream.target.indexName,
      KeyConditionExpression: hasDateRange
        ? "#pk = :pk AND data_publicacao BETWEEN :di AND :df"
        : "#pk = :pk",
      ExpressionAttributeNames: { "#pk": stream.target.pkName, ...PROJECTION_NAMES },
      ExpressionAttributeValues: {
        ":pk": stream.target.pkValue,
        ...(hasDateRange ? { ":di": params.dataInicial, ":df": params.dataFinal } : {}),
      },
      ProjectionExpression: PROJECTION_EXPRESSION,
      Limit: FETCH_PAGE_SIZE,
      ExclusiveStartKey: stream.startKey,
      ScanIndexForward: params.sort === "asc",
    }),
  );

  stream.buffer.push(...((res.Items ?? []) as TenderListItem[]));
  stream.startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  stream.hasMorePages = Boolean(res.LastEvaluatedKey);
  if (stream.buffer.length === 0 && !stream.hasMorePages) stream.exhausted = true;
}

/**
 * Busca paginada sobre N streams de GSI ao mesmo tempo (N = 1 pra "uma UF", N = |ufs| pra multi-UF,
 * N = |ufs| x |modalidades| pra busca combinada em GSI4), com DUAS garantias que a versao anterior
 * nao tinha:
 *
 * 1. **A pagina enche.** O laco continua puxando paginas brutas ate acumular `limit` itens que
 *    passem em TODOS os filtros, ou ate os streams acabarem, ou ate o teto de leitura. Antes, os
 *    filtros de keyword/valor rodavam sobre uma unica pagina bruta de tamanho `limit`, entao pedir
 *    20 resultados podia devolver 3, depois 1, depois 0 e depois mais 5 -- aleatorio pro usuario e
 *    sem relacao com quantos resultados existiam de verdade.
 *
 * 2. **Multi-valor pagina.** Cada stream carrega o proprio ExclusiveStartKey dentro de um unico
 *    cursor opaco (`{v:2, k:{targetId: key}, x:[drenados]}`), gravado pelo ULTIMO item consumido de
 *    cada stream. Itens lidos mas nao consumidos sao simplesmente relidos na proxima pagina, o que
 *    mantem o cursor stateless e sem duplicata: nenhum item e' emitido duas vezes, porque cada
 *    stream so avanca pelo que ele proprio ja entregou.
 */
export async function queryTendersMerged(params: MergedQueryParams): Promise<MergedQueryResult> {
  const { targets, limit, sort } = params;
  const accept = params.accept ?? (() => true);
  const decoded = decodeCursor(params.cursor, targets);

  const streams: Stream[] = targets.map((target) => {
    const startKey = decoded.keys[target.id];
    const exhausted = decoded.exhausted.has(target.id);
    return {
      target,
      buffer: [],
      startKey,
      hasMorePages: !exhausted,
      exhausted,
      lastConsumedKey: startKey,
    };
  });

  const emitted: TenderListItem[] = [];
  const seen = new Set<string>();
  let queriesUsed = 0;
  let partial = false;

  while (emitted.length < limit) {
    const needFill = streams.filter((s) => !s.exhausted && s.buffer.length === 0 && s.hasMorePages);
    if (needFill.length > 0) {
      if (queriesUsed + needFill.length > MAX_QUERIES_PER_REQUEST) {
        partial = true;
        break;
      }
      queriesUsed += needFill.length;
      await Promise.all(needFill.map((s) => fetchPage(s, params)));
      continue;
    }

    const ready = streams.filter((s) => s.buffer.length > 0);
    if (ready.length === 0) break;

    let best = ready[0];
    for (const candidate of ready.slice(1)) {
      if (isAhead(candidate.buffer[0], best.buffer[0], sort)) best = candidate;
    }

    const item = best.buffer.shift()!;
    best.lastConsumedKey = {
      pncp_control_number: item.pncp_control_number,
      [best.target.pkName]: best.target.pkValue,
      data_publicacao: item.data_publicacao,
    };
    if (best.buffer.length === 0 && !best.hasMorePages) best.exhausted = true;

    // Streams tem partition keys disjuntas por construcao (um tender tem UMA uf, UMA modalidade,
    // UM uf_modalidade), entao duplicata entre streams nao deveria existir -- o Set e' barato e
    // impede que uma mudanca futura na montagem dos targets vire item repetido na resposta.
    if (seen.has(item.pncp_control_number)) continue;
    seen.add(item.pncp_control_number);

    if (accept(item)) emitted.push(item);
  }

  const hasMore = streams.some((s) => !s.exhausted);
  if (!hasMore) {
    return { data: emitted, has_more: false, partial };
  }

  const state: CursorState = { v: CURSOR_VERSION, k: {}, x: [] };
  for (const stream of streams) {
    if (stream.exhausted) {
      state.x.push(stream.target.id);
      continue;
    }
    if (stream.lastConsumedKey) state.k[stream.target.id] = stream.lastConsumedKey;
  }

  return { data: emitted, next_cursor: encodeCursor(state), has_more: true, partial };
}
