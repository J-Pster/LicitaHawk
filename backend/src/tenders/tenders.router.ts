import { Router } from "express";
import { authenticate } from "../common/auth/api-key.middleware";
import { asyncHandler } from "../common/async-handler";
import { clientRateLimit } from "../common/client-rate-limit";
import {
  parseDateRange,
  parseLimit,
  parseModalidadeList,
  parseSituacaoList,
  parseSort,
  parseUfList,
  parseValorRange,
  stableParamsKey,
} from "../common/query-validation";
import { TtlCache } from "../common/ttl-cache";
import { FullTender, getFullTender } from "./tender-detail.service";
import {
  listTendersByOrgao,
  OrgaoTendersParams,
  searchTenders,
  TenderSearchParams,
  TenderSearchResult,
} from "./tenders.service";

// Router de tenders (Fase 3.1). Exportado standalone -- o team-lead registra em src/server.ts
// junto com os routers de webhook (Fase 4) e billing (Fase 5).
export const tendersRouter = Router();

// authenticate e' aplicado POR ROTA (nunca via router.use(authenticate) sem path) -- um
// router.use() sem path roda pra QUALQUER request que passe por esse router, mesmo que nenhuma
// rota dele bata (o Express so cai pro proximo router depois de rodar os middlewares do atual).
// Como varios routers (tenders/filtros/webhook/billing) sao montados juntos na raiz do app,
// isso causaria autenticacao (e incremento de UsageCounters) em duplicidade pra toda requisicao.
// clientRateLimit roda logo depois (protege contra rajada por cliente, distinto do teto mensal
// ja aplicado dentro de authenticate). asyncHandler + middleware global de erro (server.ts) --
// antes, so esta rota tinha try/catch; as outras duas derrubavam o processo inteiro num erro nao
// tratado (achado real, ver tenders.service.ts::decodeCursor).

// Cache curto (30s) de resposta pra reduzir carga no DynamoDB em queries repetidas/populares.
// Dado de tender nao e customer-especifico -- o cache e compartilhado entre clientes distintos
// que fazem a mesma busca (chave e' so a combinacao de parametros, nao inclui customer_id).
const RESPONSE_CACHE_TTL_MS = 30_000;
const searchCache = new TtlCache<TenderSearchResult>(RESPONSE_CACHE_TTL_MS);
const detailCache = new TtlCache<FullTender>(RESPONSE_CACHE_TTL_MS);
const orgaoCache = new TtlCache<TenderSearchResult>(RESPONSE_CACHE_TTL_MS);

// Exportada -- reusada por src/account/account-playground.router.ts (GET /v1/account/playground/tenders)
// pra nao duplicar a mesma extracao/validacao de query params que esta rota ja usa.
export function parseSearchQuery(query: Record<string, unknown>): TenderSearchParams {
  const get = (key: string): string | undefined => (typeof query[key] === "string" ? (query[key] as string) : undefined);
  const { dataInicial, dataFinal } = parseDateRange(get("dataInicial"), get("dataFinal"));
  const { valorMin, valorMax } = parseValorRange(get("valorMin"), get("valorMax"));
  return {
    uf: parseUfList(get("uf")),
    modalidade: parseModalidadeList(get("modalidade")),
    keyword: get("keyword"),
    municipio: get("municipio"),
    situacao: parseSituacaoList(get("situacao")),
    dataInicial,
    dataFinal,
    valorMin,
    valorMax,
    limit: parseLimit(get("limit")),
    cursor: get("cursor"),
    sort: parseSort(get("sort")),
  };
}

tendersRouter.get(
  "/v1/tenders",
  authenticate,
  clientRateLimit,
  asyncHandler(async (req, res) => {
    const params = parseSearchQuery(req.query as Record<string, unknown>);
    const cacheKey = stableParamsKey(params as unknown as Record<string, unknown>);

    const cached = searchCache.get(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      res.json(cached);
      return;
    }

    const result = await searchTenders(params);
    searchCache.set(cacheKey, result);
    res.setHeader("X-Cache", "MISS");
    res.json(result);
  }),
);

tendersRouter.get(
  "/v1/tenders/:id",
  authenticate,
  clientRateLimit,
  asyncHandler(async (req, res) => {
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    const skipFetch = req.query.detail === "cached";
    const cacheKey = req.params.id;
    const cached = refresh ? undefined : detailCache.get(cacheKey);
    if (cached !== undefined) {
      res.setHeader("X-Cache", "HIT");
      res.json({ data: cached });
      return;
    }

    // getFullTender busca no PNCP tudo que existe sobre a licitacao (itens, resultados,
    // documentos, historico) na primeira vez e persiste, entao o detalhe entregue aqui e
    // completo, nao so o recorte que a ingestao indexa para busca.
    const tender = await getFullTender(req.params.id, { refresh, skipFetch });
    if (!tender.detail_pending) {
      detailCache.set(cacheKey, tender);
    }
    res.setHeader("X-Cache", "MISS");
    res.json({ data: tender });
  }),
);

tendersRouter.get(
  "/v1/orgaos/:cnpj/tenders",
  authenticate,
  clientRateLimit,
  asyncHandler(async (req, res) => {
    const get = (key: string): string | undefined =>
      typeof req.query[key] === "string" ? (req.query[key] as string) : undefined;
    const { dataInicial, dataFinal } = parseDateRange(get("dataInicial"), get("dataFinal"));
    const { valorMin, valorMax } = parseValorRange(get("valorMin"), get("valorMax"));
    const params: OrgaoTendersParams = {
      dataInicial,
      dataFinal,
      valorMin,
      valorMax,
      keyword: get("keyword"),
      municipio: get("municipio"),
      situacao: parseSituacaoList(get("situacao")),
      limit: parseLimit(get("limit")),
      cursor: get("cursor"),
      sort: parseSort(get("sort")),
    };

    const cacheKey = `${req.params.cnpj}:${stableParamsKey(params as unknown as Record<string, unknown>)}`;
    const cached = orgaoCache.get(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      res.json(cached);
      return;
    }

    const result = await listTendersByOrgao(req.params.cnpj, params);
    orgaoCache.set(cacheKey, result);
    res.setHeader("X-Cache", "MISS");
    res.json(result);
  }),
);
