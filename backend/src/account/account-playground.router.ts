import { RequestHandler, Router } from "express";
import { cognitoAuthenticate } from "../common/auth/cognito-auth.middleware";
import { asyncHandler } from "../common/async-handler";
import { HttpError } from "../common/http-error";
import { getFullTender } from "../tenders/tender-detail.service";
import { enforceUsage, respondIfUsageExceeded } from "../common/client-rate-limit";
import { assertValidUf } from "../common/query-validation";
import { assertValidModalidadeNome } from "../common/modalidades";
import { parseDateRange, parseLimit, parseSort, parseValorRange } from "../common/query-validation";
import { parseSearchQuery } from "../tenders/tenders.router";
import {
  findRecentlyUpdatedMatches,
  listTendersByOrgao,
  OrgaoTendersParams,
  searchTenders,
} from "../tenders/tenders.service";
import { findAccountByCustomerId } from "./account.repository";

// Router do Playground do dashboard (2026-09-07): a mesma API real de busca/detalhe/webhook do
// produto, exposta autenticada por ID token do Cognito (nao por API key) -- a API key so aparece
// 1x na criacao (design de seguranca), entao o dashboard nao pode pedir pro cliente colar ela de
// volta so pra testar a propria API na tela. E' a API REAL do cliente sendo usada, so que disparada
// pela nossa UI em vez de curl -- por isso conta pro MESMO limite/uso do plano dele
// (enforceUsageForCognitoAccount abaixo), senao o Playground viraria um jeito de furar o limite.
export const accountPlaygroundRouter = Router();

/**
 * Equivalente Cognito de `authenticate` + `clientRateLimit` (src/common/auth/api-key.middleware.ts
 * / src/common/client-rate-limit.ts) juntos, mas pra rotas autenticadas por ID token do Cognito
 * (req.cognitoUser.sub), nao por API key (sem req.auth aqui). Resolve plan_tier via
 * findAccountByCustomerId, aplica o MESMO limite por minuto + a MESMA quota mensal do plano do
 * cliente (enforceUsage, reusado de client-rate-limit.ts -- nenhuma logica de limite/incremento
 * duplicada), e conta como surface "ui" (uso pelo nosso proprio Dashboard/Playground, autenticado
 * por Cognito -- distinto de "api", que e' a mesma API chamada de verdade via API key).
 */
export const enforceUsageForCognitoAccount: RequestHandler = async (req, res, next) => {
  try {
    const customerId = req.cognitoUser!.sub;
    const account = await findAccountByCustomerId(customerId);
    if (!account) {
      throw new HttpError(404, "conta nao provisionada -- chame POST /v1/account/provision primeiro", "ACCOUNT_NOT_PROVISIONED");
    }

    const result = await enforceUsage(customerId, account.plan_tier, "ui");
    if (respondIfUsageExceeded(res, result, account.plan_tier)) {
      return;
    }

    next();
  } catch (err) {
    next(err);
  }
};

// A validacao de correspondencia EXATA de modalidade (dominio oficial do PNCP) agora mora no
// proprio parseSearchQuery/parseModalidadeList (query-validation.ts), aplicada de uma vez no
// boundary e valendo igual pra API publica e pro Playground -- antes so este router validava, e
// GET /v1/tenders aceitava texto livre que nunca casaria com nada.

accountPlaygroundRouter.get(
  "/v1/account/playground/tenders",
  cognitoAuthenticate,
  enforceUsageForCognitoAccount,
  asyncHandler(async (req, res) => {
    const params = parseSearchQuery(req.query as Record<string, unknown>);
    const result = await searchTenders(params);
    res.json(result);
  }),
);

accountPlaygroundRouter.get(
  "/v1/account/playground/tenders/:id",
  cognitoAuthenticate,
  enforceUsageForCognitoAccount,
  asyncHandler(async (req, res) => {
    // Mesmo payload completo de GET /v1/tenders/:id: o dashboard mostra a licitacao inteira
    // (itens, resultados, documentos, historico), nao um resumo diferente do da API publica.
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    const skipFetch = req.query.detail === "cached";
    const tender = await getFullTender(req.params.id, { refresh, skipFetch });
    res.json({ data: tender });
  }),
);

// Espelha GET /v1/orgaos/:cnpj/tenders (src/tenders/tenders.router.ts, autenticado por API key)
// pro Playground do dashboard -- ate 2026-09-07 esse endpoint de historico do orgao existia so na
// API real, nunca exposto/chamado via Cognito, mesmo padrao das outras rotas deste router (mesma
// auth + enforceUsageForCognitoAccount, mesmos query params de data/valor/sort/cursor, delegado
// inteiramente a listTendersByOrgao pra nao duplicar logica de Query/paginacao).
accountPlaygroundRouter.get(
  "/v1/account/playground/orgaos/:cnpj/tenders",
  cognitoAuthenticate,
  enforceUsageForCognitoAccount,
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
      limit: parseLimit(get("limit")),
      cursor: get("cursor"),
      sort: parseSort(get("sort")),
    };

    const result = await listTendersByOrgao(req.params.cnpj, params);
    res.json(result);
  }),
);

/**
 * NAO e' um webhook de verdade -- nao passa pelo SSRF guard/dispatcher real (src/webhook/), que e'
 * so pra URL de cliente controlada por ele (localhost sempre seria bloqueado, corretamente). E'
 * uma consulta que reusa a MESMA logica de correspondencia de um filtro salvo de verdade
 * (uf+modalidade obrigatorios, keyword opcional -- ver findRecentlyUpdatedMatches em
 * tenders.service.ts), ordenada pelas licitacoes mais recentemente atualizadas. Honesto sobre ser
 * polling, nao push: a ingestao real roda a cada ~15min (scheduler.ts), entao "chegar na tela"
 * reflete essa cadencia, nao e' tempo real de verdade.
 */
accountPlaygroundRouter.get(
  "/v1/account/playground/webhook-preview",
  cognitoAuthenticate,
  enforceUsageForCognitoAccount,
  asyncHandler(async (req, res) => {
    const get = (key: string): string | undefined =>
      typeof req.query[key] === "string" ? (req.query[key] as string) : undefined;

    const uf = get("uf");
    const modalidade = get("modalidade");
    const keyword = get("keyword");
    const since = get("since");

    if (!uf || !modalidade) {
      throw new HttpError(400, "'uf' e 'modalidade' sao obrigatorios", "VALIDATION_ERROR");
    }
    assertValidUf(uf);
    assertValidModalidadeNome(modalidade);
    if (since !== undefined && Number.isNaN(new Date(since).getTime())) {
      throw new HttpError(400, "'since' deve ser uma data ISO 8601 valida", "VALIDATION_ERROR");
    }

    const result = await findRecentlyUpdatedMatches({ uf: uf.toUpperCase(), modalidade, keyword, since });
    res.json({ data: { tenders: result.tenders, since: result.since } });
  }),
);
