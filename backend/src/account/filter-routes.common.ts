import { HttpError } from "../common/http-error";
import { assertValidUf } from "../common/query-validation";
import { isValidModalidadeNome, MODALIDADES } from "../common/modalidades";
import { PLANS, PlanDefinition } from "../billing/plans";
import { SavedFilter } from "../webhook/filter.types";
import { listFiltersForCustomer } from "../filters/filters.service";
import { findAccountByCustomerId } from "./account.repository";

/**
 * Regras que as duas colecoes de alerta (webhook e email) compartilham. Ficam aqui, e nao
 * duplicadas nos dois routers, porque sao a MESMA regra de produto: o mesmo dominio de UF e
 * modalidade, o mesmo teto de filtros por plano. Se amanha o teto virar por canal, o lugar de
 * mudar continua sendo um so.
 */

/** Plano real da conta -- vem de ApiKeys (nao existe no ID token do Cognito), mesmo criterio de
 * enforcement ja usado em filters.router.ts (webhooksEnabled/maxFilters). */
export async function requirePlan(customerId: string): Promise<PlanDefinition> {
  const account = await findAccountByCustomerId(customerId);
  if (!account) {
    throw new HttpError(
      404,
      "conta nao provisionada -- chame POST /v1/account/provision primeiro",
      "ACCOUNT_NOT_PROVISIONED",
    );
  }
  return PLANS[account.plan_tier];
}

/**
 * Email de destino do alerta: sempre o da conta (claim do Cognito espelhado em ApiKeys.email).
 * Conta sem email nao pode criar alerta por email -- falha aqui, na criacao, em vez de virar um
 * alerta que nunca entrega e so aparece como falha no circuit breaker semanas depois.
 */
export async function requireAccountEmail(customerId: string): Promise<string> {
  const account = await findAccountByCustomerId(customerId);
  if (!account?.email) {
    throw new HttpError(
      409,
      "conta sem email cadastrado -- entre de novo no painel para sincronizar o email da sua conta",
      "ACCOUNT_EMAIL_MISSING",
    );
  }
  return account.email;
}

/**
 * Criterio de disparo. Diferente de GET /v1/tenders?modalidade= (Fase 3, texto livre de
 * proposito), aqui modalidade vira o valor exato da GSI uf+modalidade que o matcher usa
 * (tender-matcher.adapter.ts) -- string que nao bater com o dominio oficial do PNCP cria um
 * filtro que nunca dispara, silenciosamente, para sempre. O dashboard usa <select>, mas qualquer
 * outro cliente batendo direto nesta rota tambem precisa ser barrado aqui, nao so na UI.
 */
export function assertValidCriteria(uf: string, modalidade: string): void {
  assertValidUf(uf);
  if (!isValidModalidadeNome(modalidade)) {
    throw new HttpError(
      400,
      `modalidade invalida. Valores aceitos: ${MODALIDADES.map((m) => m.nome).join(", ")}`,
      "VALIDATION_ERROR",
    );
  }
}

/**
 * Teto do plano. Webhook e alerta por email dividem o mesmo balde `maxFilters` de proposito: para
 * o produto os dois sao "um alerta", o que muda e' por onde ele chega.
 */
export async function assertCanCreateFilter(customerId: string, plan: PlanDefinition): Promise<void> {
  if (!plan.webhooksEnabled) {
    throw new HttpError(403, `plano ${plan.name} nao inclui alertas`, "PLAN_LIMIT_EXCEEDED");
  }
  const existing = await listFiltersForCustomer(customerId);
  if (existing.length >= plan.maxFilters) {
    throw new HttpError(
      403,
      `limite de ${plan.maxFilters} alerta(s) do plano ${plan.name} atingido`,
      "PLAN_LIMIT_EXCEEDED",
    );
  }
}

/**
 * Um id de alerta por email nao e' um recurso da colecao de webhooks (e vice-versa). Responder
 * 404 aqui, e nao 400, e' deliberado: a colecao errada simplesmente nao contem esse id.
 */
export function assertChannel<C extends SavedFilter["channel"]>(
  filter: SavedFilter,
  channel: C,
): Extract<SavedFilter, { channel: C }> {
  if (filter.channel !== channel) {
    throw new HttpError(404, "filtro nao encontrado", "NOT_FOUND");
  }
  return filter as Extract<SavedFilter, { channel: C }>;
}
