/**
 * Um filtro salvo e' um criterio (uf + modalidade + keyword) mais UM canal de entrega. Os dois
 * canais compartilham tudo o resto: matcher, fila, retry, circuit breaker e log de entregas.
 *
 * Uniao discriminada em vez de um registro com campos opcionais de proposito: um filtro de email
 * com `webhook_url` preenchido, ou um webhook sem `webhook_secret`, sao estados que simplesmente
 * nao existem no dominio -- e com uniao o compilador cobra a decisao em cada ponto de uso, em vez
 * de deixar um `if (filter.webhook_url)` decidir tarde e errado.
 */

export type AlertChannel = "webhook" | "email";

interface SavedFilterBase {
  customer_id: string;
  filter_id: string;
  // Label opcional definido pelo cliente (dashboard, src/account/account-webhooks.router.ts) --
  // null quando nao informado na criacao (o frontend pode gerar um label automatico nesse caso).
  name: string | null;
  uf: string;
  modalidade: string;
  keyword?: string;
  active: boolean;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export interface SavedWebhookFilter extends SavedFilterBase {
  channel: "webhook";
  webhook_url: string;
  // CSPRNG, gerado com crypto.randomBytes(32) -- nunca logado, nem em mensagem de erro.
  webhook_secret: string;
}

/**
 * Alerta por email. Nao guarda destinatario: o email e' sempre o da conta (claim do Cognito
 * espelhado em ApiKeys.email) e e' resolvido no momento do envio. Guardar uma copia aqui criaria
 * um endereco que envelhece em silencio -- o usuario troca o email da conta e o alerta continua
 * indo pro antigo, que pode ja nem ser dele.
 */
export interface SavedEmailFilter extends SavedFilterBase {
  channel: "email";
}

export type SavedFilter = SavedWebhookFilter | SavedEmailFilter;

export function isWebhookFilter(filter: SavedFilter): filter is SavedWebhookFilter {
  return filter.channel === "webhook";
}

/**
 * Fronteira de leitura do DynamoDB: item cru vira SavedFilter aqui, uma vez, e o resto do codigo
 * confia no tipo. Item gravado antes do canal existir nao tem `channel` e e', por definicao, um
 * webhook (era o unico canal) -- politica de compatibilidade explicita, nao fallback disfarcado.
 */
export function parseSavedFilter(item: Record<string, unknown>): SavedFilter {
  return (item.channel ?? "webhook") === "email"
    ? ({ ...item, channel: "email" } as SavedEmailFilter)
    : ({ ...item, channel: "webhook" } as SavedWebhookFilter);
}

export function parseSavedFilters(items: Record<string, unknown>[]): SavedFilter[] {
  return items.map(parseSavedFilter);
}
