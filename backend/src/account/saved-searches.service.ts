import { randomUUID } from "crypto";
import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { HttpError } from "../common/http-error";
import { assertValidModalidadeNome } from "../common/modalidades";
import { assertUfOrModalidade, assertValidUf, MAX_MULTI_VALUES, parseDateRange } from "../common/query-validation";
import { assertSavedSearchOwnership, SavedSearchNotFoundError } from "../common/saved-search-ownership";
import { queryTendersMerged } from "../tenders/tender-query";
import { buildTenderFilter, buildTenderQueryTargets } from "../tenders/tenders.service";
import { SavedSearch, SavedSearchCriteria } from "./saved-search.types";

const SAVED_SEARCHES_TABLE = "SavedSearches";

// Teto de contagem de GET /:id/new-count: contamos ate este numero de matches (exato ate aqui) e
// paramos; acima disso devolvemos o proprio teto como sinal de "100 ou mais", em vez de varrer a
// base so pra dar precisao infinita a algo que o usuario so precisa saber se e' "zero", "poucos" ou
// "muitos".
const NEW_COUNT_CAP = 100;

// Limite superior lexicografico do sort key `data_publicacao` (string ISO 8601). Usado quando o
// criterio salvo nao define `dataFinal`: o BETWEEN do DynamoDB exige os dois extremos, e qualquer
// data real ordena antes deste valor.
const MAX_SORT_KEY = "9999-12-31T23:59:59.999Z";

/**
 * Mesma regra de uf XOR modalidade de tenders.service.ts::searchTenders (assertUfXorModalidade),
 * mais validacao de tipo/dominio dos demais campos do criterio salvo. Modalidade exige
 * correspondencia EXATA com o dominio oficial do PNCP (mesmo motivo de
 * account-webhooks.router.ts/account-playground.router.ts): uma string que nao bata nunca teria
 * match nenhum, silenciosamente, para sempre.
 */
function validateCriteria(criteria: SavedSearchCriteria | undefined | null): SavedSearchCriteria {
  if (!criteria || typeof criteria !== "object") {
    throw new HttpError(400, "'criteria' e obrigatorio", "VALIDATION_ERROR");
  }

  if (criteria.uf !== undefined) {
    if (!Array.isArray(criteria.uf) || criteria.uf.some((v) => typeof v !== "string")) {
      throw new HttpError(400, "'criteria.uf' deve ser uma lista de strings", "VALIDATION_ERROR");
    }
  }
  if (criteria.modalidade !== undefined) {
    if (!Array.isArray(criteria.modalidade) || criteria.modalidade.some((v) => typeof v !== "string")) {
      throw new HttpError(400, "'criteria.modalidade' deve ser uma lista de strings", "VALIDATION_ERROR");
    }
  }
  // Mesmo teto e dedupe (via Set) que query-validation.ts::parseUfList/parseModalidadeList aplicam
  // na busca ad-hoc -- sem isso, countNewMatchesForSavedSearch (que pagina ate
  // NEW_COUNT_MAX_PAGES_PER_VALUE por valor do array) multiplicaria seu custo sem limite a cada
  // ciclo de polling do frontend.
  const ufList = [...new Set(criteria.uf?.map((v) => v.toUpperCase()) ?? [])];
  const modalidadeList = [...new Set(criteria.modalidade ?? [])];
  if (ufList.length > MAX_MULTI_VALUES) {
    throw new HttpError(400, `'criteria.uf' aceita no maximo ${MAX_MULTI_VALUES} valores`, "VALIDATION_ERROR");
  }
  if (modalidadeList.length > MAX_MULTI_VALUES) {
    throw new HttpError(400, `'criteria.modalidade' aceita no maximo ${MAX_MULTI_VALUES} valores`, "VALIDATION_ERROR");
  }
  ufList.forEach(assertValidUf);
  modalidadeList.forEach(assertValidModalidadeNome);
  assertUfOrModalidade(ufList, modalidadeList);

  if (criteria.keyword !== undefined && typeof criteria.keyword !== "string") {
    throw new HttpError(400, "'criteria.keyword' deve ser string", "VALIDATION_ERROR");
  }
  if (criteria.municipio !== undefined && typeof criteria.municipio !== "string") {
    throw new HttpError(400, "'criteria.municipio' deve ser string", "VALIDATION_ERROR");
  }
  if (criteria.situacao !== undefined) {
    if (!Array.isArray(criteria.situacao) || criteria.situacao.some((v) => typeof v !== "string")) {
      throw new HttpError(400, "'criteria.situacao' deve ser uma lista de strings", "VALIDATION_ERROR");
    }
    if (criteria.situacao.length > MAX_MULTI_VALUES) {
      throw new HttpError(400, `'criteria.situacao' aceita no maximo ${MAX_MULTI_VALUES} valores`, "VALIDATION_ERROR");
    }
  }
  if (criteria.valorMin !== undefined && (typeof criteria.valorMin !== "number" || Number.isNaN(criteria.valorMin) || criteria.valorMin < 0)) {
    throw new HttpError(400, "'criteria.valorMin' deve ser um numero >= 0", "VALIDATION_ERROR");
  }
  if (criteria.valorMax !== undefined && (typeof criteria.valorMax !== "number" || Number.isNaN(criteria.valorMax) || criteria.valorMax < 0)) {
    throw new HttpError(400, "'criteria.valorMax' deve ser um numero >= 0", "VALIDATION_ERROR");
  }
  if (criteria.valorMin !== undefined && criteria.valorMax !== undefined && criteria.valorMin > criteria.valorMax) {
    throw new HttpError(400, "'criteria.valorMin' nao pode ser maior que 'criteria.valorMax'", "VALIDATION_ERROR");
  }
  // parseDateRange ja valida formato ISO e ordem cronologica (query-validation.ts) -- reusada, nao duplicada.
  const { dataInicial, dataFinal } = parseDateRange(criteria.dataInicial, criteria.dataFinal);
  if (criteria.sort !== undefined && criteria.sort !== "asc" && criteria.sort !== "desc") {
    throw new HttpError(400, "'criteria.sort' deve ser 'asc' ou 'desc'", "VALIDATION_ERROR");
  }

  return {
    uf: ufList.length > 0 ? ufList : undefined,
    modalidade: modalidadeList.length > 0 ? modalidadeList : undefined,
    keyword: criteria.keyword,
    municipio: criteria.municipio,
    situacao: criteria.situacao?.length ? [...new Set(criteria.situacao)] : undefined,
    valorMin: criteria.valorMin,
    valorMax: criteria.valorMax,
    dataInicial,
    dataFinal,
    sort: criteria.sort,
  };
}

export interface CreateSavedSearchInput {
  name: string;
  criteria: SavedSearchCriteria;
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new HttpError(400, "'name' e obrigatorio", "VALIDATION_ERROR");
  }
  return name.trim();
}

export async function createSavedSearch(accountId: string, input: CreateSavedSearchInput): Promise<SavedSearch> {
  const now = new Date().toISOString();
  const savedSearch: SavedSearch = {
    account_id: accountId,
    saved_search_id: randomUUID(),
    name: validateName(input.name),
    criteria: validateCriteria(input.criteria),
    created_at: now,
    updated_at: now,
    last_seen_at: null,
  };
  await ddbDocClient.send(new PutCommand({ TableName: SAVED_SEARCHES_TABLE, Item: savedSearch }));
  return savedSearch;
}

// Query por account_id (PK) -- nunca Scan; so lista os saved searches do proprio dono por construcao.
export async function listSavedSearchesForAccount(accountId: string): Promise<SavedSearch[]> {
  const res = await ddbDocClient.send(
    new QueryCommand({
      TableName: SAVED_SEARCHES_TABLE,
      KeyConditionExpression: "account_id = :aid",
      ExpressionAttributeValues: { ":aid": accountId },
    }),
  );
  return (res.Items ?? []) as SavedSearch[];
}

export interface UpdateSavedSearchInput {
  name?: string;
  criteria?: SavedSearchCriteria;
}

export async function updateSavedSearch(
  accountId: string,
  savedSearchId: string,
  fields: UpdateSavedSearchInput,
): Promise<SavedSearch | undefined> {
  try {
    await assertSavedSearchOwnership(accountId, savedSearchId);
  } catch (err) {
    if (err instanceof SavedSearchNotFoundError) return undefined;
    throw err;
  }

  const setExpressions: string[] = ["#updated_at = :now"];
  const names: Record<string, string> = { "#updated_at": "updated_at" };
  const values: Record<string, unknown> = { ":now": new Date().toISOString() };

  if (fields.name !== undefined) {
    names["#name"] = "name";
    values[":name"] = validateName(fields.name);
    setExpressions.push("#name = :name");
  }
  if (fields.criteria !== undefined) {
    names["#criteria"] = "criteria";
    values[":criteria"] = validateCriteria(fields.criteria);
    setExpressions.push("#criteria = :criteria");
  }

  const res = await ddbDocClient.send(
    new UpdateCommand({
      TableName: SAVED_SEARCHES_TABLE,
      Key: { account_id: accountId, saved_search_id: savedSearchId },
      UpdateExpression: `SET ${setExpressions.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes as SavedSearch;
}

export async function deleteSavedSearch(accountId: string, savedSearchId: string): Promise<boolean> {
  try {
    await assertSavedSearchOwnership(accountId, savedSearchId);
  } catch (err) {
    if (err instanceof SavedSearchNotFoundError) return false;
    throw err;
  }
  await ddbDocClient.send(
    new DeleteCommand({ TableName: SAVED_SEARCHES_TABLE, Key: { account_id: accountId, saved_search_id: savedSearchId } }),
  );
  return true;
}

export async function markSavedSearchSeen(accountId: string, savedSearchId: string): Promise<SavedSearch | undefined> {
  try {
    await assertSavedSearchOwnership(accountId, savedSearchId);
  } catch (err) {
    if (err instanceof SavedSearchNotFoundError) return undefined;
    throw err;
  }

  const now = new Date().toISOString();
  const res = await ddbDocClient.send(
    new UpdateCommand({
      TableName: SAVED_SEARCHES_TABLE,
      Key: { account_id: accountId, saved_search_id: savedSearchId },
      UpdateExpression: "SET last_seen_at = :now, updated_at = :now",
      ExpressionAttributeValues: { ":now": now },
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes as SavedSearch;
}

export interface NewCountResult {
  found: boolean;
  new_count: number;
}

/**
 * Roda a MESMA logica de busca de tenders.service.ts::searchTenders sobre o criterio salvo (mesmos
 * streams de GSI, mesmos filtros em memoria), mas so CONTA tenders publicados depois do ultimo
 * "visto": `data_publicacao > last_seen_at`, ou `>= created_at` se o saved search nunca foi marcado
 * como visto (last_seen_at null) -- `>=` porque um tender publicado no exato instante da criacao do
 * saved search ainda deve contar como "novo" pro usuario que acabou de salvar o filtro.
 *
 * A contagem para em NEW_COUNT_CAP: acima disso devolvemos o proprio teto como "100 ou mais", em vez
 * de varrer a base so pra dar precisao infinita a algo que o usuario so precisa saber se e' "zero",
 * "poucos" ou "muitos". O motor de merge ja pagina internamente ate juntar esse teto (ou esgotar os
 * itens novos, ou bater o proprio teto de leitura por chamada), o que corrige de vez a subestimativa
 * antiga de filtrar so a primeira pagina bruta.
 *
 * Correcao de bug junto: `criteria.dataInicial`/`dataFinal` eram ignorados aqui (a contagem podia
 * incluir tenders fora da janela de datas do proprio filtro salvo). Agora a janela do criterio e a
 * janela do "desde o ultimo visto" sao compostas -- vale a mais restritiva das duas.
 *
 * NAO atualiza last_seen_at (isso e' responsabilidade exclusiva de markSavedSearchSeen/mark-seen) --
 * um simples "quantos tem de novo?" nao pode consumir a marca de "visto" sozinho, senao o badge
 * zeraria so de o usuario abrir a tela que exibe a contagem.
 */
export async function countNewMatchesForSavedSearch(accountId: string, savedSearchId: string): Promise<NewCountResult> {
  let savedSearch: SavedSearch;
  try {
    savedSearch = await assertSavedSearchOwnership(accountId, savedSearchId);
  } catch (err) {
    if (err instanceof SavedSearchNotFoundError) return { found: false, new_count: 0 };
    throw err;
  }

  const { criteria } = savedSearch;
  const targets = buildTenderQueryTargets(criteria.uf ?? [], criteria.modalidade ?? []);

  const isFirstView = savedSearch.last_seen_at === null;
  const cutoff = savedSearch.last_seen_at ?? savedSearch.created_at;

  // A faixa do indice e' a intersecao da janela do criterio com "publicado depois do cutoff".
  // `BETWEEN` do DynamoDB e' inclusivo nos dois extremos, entao a exclusividade do `>` (quando ja
  // houve um mark-seen) e' aplicada no predicado em memoria -- nao da pra pedir "estritamente maior"
  // numa KeyConditionExpression com BETWEEN, e arredondar a data seria errado por milissegundos.
  const lowerBound = criteria.dataInicial && criteria.dataInicial > cutoff ? criteria.dataInicial : cutoff;
  const upperBound = criteria.dataFinal ?? MAX_SORT_KEY;
  const matchesCriteria = buildTenderFilter(criteria);

  const res = await queryTendersMerged({
    targets,
    limit: NEW_COUNT_CAP,
    sort: "desc",
    dataInicial: lowerBound,
    dataFinal: upperBound,
    accept: (tender) => {
      if (!isFirstView && tender.data_publicacao <= cutoff) return false;
      return matchesCriteria(tender);
    },
  });

  return { found: true, new_count: Math.min(res.data.length, NEW_COUNT_CAP) };
}
