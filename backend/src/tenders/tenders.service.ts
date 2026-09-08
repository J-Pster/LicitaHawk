import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { matchesKeyword, normalizeText } from "../common/keyword-match";
import { assertUfOrModalidade, SortOrder } from "../common/query-validation";
import {
  MergedQueryResult,
  queryTendersMerged,
  QueryTarget,
  TENDER_INDEX,
  TENDERS_TABLE,
} from "./tender-query";
import { ufModalidadeKey } from "./uf-modalidade-key";
import { Tender, TenderListItem } from "./tender.types";

export interface TenderFilters {
  keyword?: string;
  valorMin?: number;
  valorMax?: number;
  municipio?: string;
  situacao?: string[];
}

export interface TenderSearchParams extends TenderFilters {
  uf?: string[];
  modalidade?: string[];
  dataInicial?: string;
  dataFinal?: string;
  limit?: number;
  cursor?: string;
  sort?: SortOrder;
}

export type TenderSearchResult = MergedQueryResult;

/**
 * Monta os streams de GSI que respondem ao recorte pedido. Tres formatos, um por indice:
 *
 * - so `uf`      -> GSI1, uma Query por UF
 * - so `modalidade` -> GSI2, uma Query por modalidade
 * - os DOIS      -> GSI4 (`uf_modalidade`), uma Query por PAR (produto cartesiano)
 *
 * O terceiro caso e' o que antes a API recusava com 400 ("informe uf OU modalidade"): sem uma
 * partition key composta nao havia como o DynamoDB intersectar dois indices, e Scan e' proibido.
 * O teto do produto cartesiano e' aplicado no boundary (assertUfOrModalidade).
 */
export function buildTenderQueryTargets(ufList: string[], modalidadeList: string[]): QueryTarget[] {
  assertUfOrModalidade(ufList, modalidadeList);

  if (ufList.length > 0 && modalidadeList.length > 0) {
    return ufList.flatMap((uf) =>
      modalidadeList.map((modalidade) => {
        const pkValue = ufModalidadeKey(uf, modalidade);
        return { id: `um:${pkValue}`, indexName: TENDER_INDEX.UF_MODALIDADE, pkName: "uf_modalidade", pkValue };
      }),
    );
  }

  if (ufList.length > 0) {
    return ufList.map((uf) => ({ id: `uf:${uf}`, indexName: TENDER_INDEX.UF, pkName: "uf", pkValue: uf }));
  }

  return modalidadeList.map((modalidade) => ({
    id: `mo:${modalidade}`,
    indexName: TENDER_INDEX.MODALIDADE,
    pkName: "modalidade",
    pkValue: modalidade,
  }));
}

// Exportada -- reusada por src/account/saved-searches.service.ts (contagem de novos matches de um
// criterio salvo) pra nao duplicar a mesma logica de filtro de faixa de valor_estimado.
export function matchesValorRange(
  tender: TenderListItem,
  valorMin: number | undefined,
  valorMax: number | undefined,
): boolean {
  const valor = tender.valor_estimado ?? 0;
  if (valorMin !== undefined && valor < valorMin) return false;
  if (valorMax !== undefined && valor > valorMax) return false;
  return true;
}

/**
 * Os filtros que nenhum GSI sabe aplicar, num unico predicado. Rodam em memoria sobre as paginas
 * brutas que o motor de merge le -- e e' justamente por isso que o motor continua puxando paginas
 * ate encher `limit` (ver tender-query.ts), em vez de devolver o que sobrou de uma unica pagina.
 *
 * `municipio` e `situacao` casam por substring normalizada (sem acento, sem caixa), mesma regra da
 * keyword: quem digita "goiania" acha "Goiânia" e quem digita "divulgada" acha "Divulgada no PNCP".
 */
export function buildTenderFilter(filters: TenderFilters): (tender: TenderListItem) => boolean {
  const municipio = filters.municipio?.trim() ? normalizeText(filters.municipio.trim()) : undefined;
  const situacoes = filters.situacao?.length ? filters.situacao.map((s) => normalizeText(s)) : undefined;

  return (tender) => {
    if (!matchesKeyword(tender, filters.keyword)) return false;
    if (!matchesValorRange(tender, filters.valorMin, filters.valorMax)) return false;
    if (municipio && !normalizeText(tender.municipio ?? "").includes(municipio)) return false;
    if (situacoes) {
      const situacao = normalizeText(tender.situacao ?? "");
      if (!situacoes.some((wanted) => situacao.includes(wanted))) return false;
    }
    return true;
  };
}

export async function getTenderById(pncpControlNumber: string): Promise<Tender | undefined> {
  const res = await ddbDocClient.send(
    new GetCommand({ TableName: TENDERS_TABLE, Key: { pncp_control_number: pncpControlNumber } }),
  );
  return res.Item as Tender | undefined;
}

/**
 * Busca sempre via GSI (nunca Scan), com pagina cheia e cursor estavel em qualquer combinacao de
 * filtros -- inclusive multi-valor e uf+modalidade juntos. Toda a mecanica de merge/paginacao vive
 * em tender-query.ts; aqui fica so a traducao de "criterio do produto" pra "streams de indice +
 * predicado em memoria".
 */
export async function searchTenders(params: TenderSearchParams): Promise<TenderSearchResult> {
  const targets = buildTenderQueryTargets(params.uf ?? [], params.modalidade ?? []);

  return queryTendersMerged({
    targets,
    limit: params.limit ?? 20,
    sort: params.sort ?? "desc",
    dataInicial: params.dataInicial,
    dataFinal: params.dataFinal,
    cursor: params.cursor,
    accept: buildTenderFilter(params),
  });
}

export interface WebhookPreviewParams {
  uf: string;
  modalidade: string;
  keyword?: string;
  since?: string;
}

export interface WebhookPreviewResult {
  tenders: TenderListItem[];
  since?: string;
}

// Teto de leitura por chamada do Playground. Continua existindo porque GSI4 ordena por
// data_publicacao e esta previa ordena por data_atualizacao -- nao ha indice por data_atualizacao,
// entao um tender recem-ATUALIZADO mas publicado ha muito tempo pode ficar fora da janela lida.
// A diferenca pro que existia antes: a leitura agora e' da particao EXATA uf+modalidade (GSI4), nao
// da UF inteira com a modalidade filtrada em memoria -- pro mesmo teto de itens lidos, a cobertura
// real do par (uf, modalidade) e' ordens de grandeza maior.
const WEBHOOK_PREVIEW_SCAN_LIMIT = 200;
const WEBHOOK_PREVIEW_RESULT_LIMIT = 50;

/**
 * Simula a correspondencia de um filtro salvo (uf+modalidade obrigatorios, keyword opcional,
 * igualdade EXATA de modalidade -- mesmo criterio do matcher real em tender-matcher.adapter.ts)
 * sem criar um webhook de verdade. Usada por GET /v1/account/playground/webhook-preview
 * (src/account/account-playground.router.ts) -- e' honestamente polling, nao push: a ingestao
 * real roda a cada ~15min (scheduler.ts), entao "chegar na tela" reflete essa cadencia.
 */
export async function findRecentlyUpdatedMatches(params: WebhookPreviewParams): Promise<WebhookPreviewResult> {
  const pkValue = ufModalidadeKey(params.uf, params.modalidade);
  const res = await queryTendersMerged({
    targets: [
      { id: `um:${pkValue}`, indexName: TENDER_INDEX.UF_MODALIDADE, pkName: "uf_modalidade", pkValue },
    ],
    limit: WEBHOOK_PREVIEW_SCAN_LIMIT,
    sort: "desc",
    accept: (tender) => matchesKeyword(tender, params.keyword),
  });

  let items = res.data;
  if (params.since) {
    items = items.filter((tender) => tender.data_atualizacao > params.since!);
  }

  items = [...items].sort((a, b) => b.data_atualizacao.localeCompare(a.data_atualizacao));
  const sliced = items.slice(0, WEBHOOK_PREVIEW_RESULT_LIMIT);

  return {
    tenders: sliced,
    since: sliced[0]?.data_atualizacao ?? params.since,
  };
}

export interface OrgaoTendersParams extends TenderFilters {
  dataInicial?: string;
  dataFinal?: string;
  limit?: number;
  cursor?: string;
  sort?: SortOrder;
}

/** Busca por org_cnpj via GSI3 -- nunca Scan. Mesmo motor (pagina cheia + cursor) da busca geral. */
export async function listTendersByOrgao(cnpj: string, params: OrgaoTendersParams): Promise<TenderSearchResult> {
  return queryTendersMerged({
    targets: [{ id: `cnpj:${cnpj}`, indexName: TENDER_INDEX.ORG_CNPJ, pkName: "org_cnpj", pkValue: cnpj }],
    limit: params.limit ?? 20,
    sort: params.sort ?? "desc",
    dataInicial: params.dataInicial,
    dataFinal: params.dataFinal,
    cursor: params.cursor,
    accept: buildTenderFilter(params),
  });
}
