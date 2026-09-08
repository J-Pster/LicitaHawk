import { randomBytes, randomUUID } from "crypto";
import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { assertFilterOwnership, FilterNotFoundError } from "../common/filter-ownership";
import { parseSavedFilter, parseSavedFilters, SavedFilter } from "../webhook/filter.types";

const SAVED_FILTERS_TABLE = "SavedFilters";
const WEBHOOK_DELIVERY_LOG_TABLE = "WebhookDeliveryLog";

/**
 * Operacao pedida em um canal que nao e' o do filtro (ex.: trocar a URL de um alerta por email,
 * regenerar o secret de algo que nao assina nada). Erro proprio, e nao um `false` generico, pra
 * que o router responda 409 em vez de fingir que o filtro nao existe.
 */
export class ChannelMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelMismatchError";
  }
}

interface CreateFilterInputBase {
  uf: string;
  modalidade: string;
  keyword?: string;
  // Label opcional (src/account/account-webhooks.router.ts) -- undefined/"" vira null.
  name?: string | null;
}

export type CreateFilterInput =
  | (CreateFilterInputBase & { channel: "webhook"; webhook_url: string })
  | (CreateFilterInputBase & { channel: "email" });

/**
 * uf e modalidade sao usados pelo matcher da Fase 4 (GSI uf+modalidade em SavedFilters) -- por
 * isso sao obrigatorios aqui, na criacao, e nao apenas documentados como opcionais. No canal
 * webhook, `webhook_url` entra na mesma regra e `webhook_secret` e' CSPRNG (nunca logado, nunca
 * retornado em GET /v1/filters depois da criacao -- ver filters.router.ts). O canal email nao
 * guarda destinatario: e' sempre o email da conta, resolvido no envio (ver filter.types.ts).
 */
export async function createFilter(customerId: string, input: CreateFilterInput): Promise<SavedFilter> {
  const now = new Date().toISOString();
  const base = {
    customer_id: customerId,
    filter_id: randomUUID(),
    name: input.name && input.name.trim().length > 0 ? input.name.trim() : null,
    uf: input.uf,
    modalidade: input.modalidade,
    keyword: input.keyword,
    active: true,
    consecutive_failures: 0,
    created_at: now,
    updated_at: now,
  };

  const filter: SavedFilter =
    input.channel === "webhook"
      ? {
          ...base,
          channel: "webhook",
          webhook_url: input.webhook_url,
          webhook_secret: randomBytes(32).toString("hex"),
        }
      : { ...base, channel: "email" };

  await ddbDocClient.send(new PutCommand({ TableName: SAVED_FILTERS_TABLE, Item: filter }));
  return filter;
}

// Query por customer_id (PK) -- nunca Scan; so lista filtros do proprio dono por construcao.
export async function listFiltersForCustomer(customerId: string): Promise<SavedFilter[]> {
  const res = await ddbDocClient.send(
    new QueryCommand({
      TableName: SAVED_FILTERS_TABLE,
      KeyConditionExpression: "customer_id = :cid",
      ExpressionAttributeValues: { ":cid": customerId },
    }),
  );
  return parseSavedFilters((res.Items ?? []) as Record<string, unknown>[]);
}

/** Mesma Query de listFiltersForCustomer, restrita a um canal -- as telas de Alertas e de
 * Webhooks listam recortes diferentes da mesma tabela. */
export async function listFiltersByChannel(
  customerId: string,
  channel: SavedFilter["channel"],
): Promise<SavedFilter[]> {
  const filters = await listFiltersForCustomer(customerId);
  return filters.filter((filter) => filter.channel === channel);
}

export async function deleteOwnedFilter(customerId: string, filterId: string): Promise<boolean> {
  try {
    await assertFilterOwnership(customerId, filterId);
  } catch (err) {
    if (err instanceof FilterNotFoundError) return false;
    throw err;
  }
  await ddbDocClient.send(
    new DeleteCommand({ TableName: SAVED_FILTERS_TABLE, Key: { customer_id: customerId, filter_id: filterId } }),
  );
  return true;
}

export interface DeliveriesResult {
  found: boolean;
  deliveries: Record<string, unknown>[];
}

/**
 * WebhookDeliveryLog tem PK=filter_id (nao customer_id) -- por isso a checagem de dono via
 * assertFilterOwnership e' explicita aqui, diferente de listFiltersForCustomer onde a key
 * condition (PK=customer_id) ja basta.
 */
export async function listDeliveriesForOwnedFilter(customerId: string, filterId: string): Promise<DeliveriesResult> {
  try {
    await assertFilterOwnership(customerId, filterId);
  } catch (err) {
    if (err instanceof FilterNotFoundError) return { found: false, deliveries: [] };
    throw err;
  }

  const res = await ddbDocClient.send(
    new QueryCommand({
      TableName: WEBHOOK_DELIVERY_LOG_TABLE,
      KeyConditionExpression: "filter_id = :fid",
      ExpressionAttributeValues: { ":fid": filterId },
      ScanIndexForward: false,
    }),
  );

  return { found: true, deliveries: res.Items ?? [] };
}

export interface UpdateFilterInput {
  name?: string | null;
  webhook_url?: string;
}

export async function updateOwnedFilter(
  customerId: string,
  filterId: string,
  fields: UpdateFilterInput,
): Promise<SavedFilter | undefined> {
  let current: SavedFilter;
  try {
    current = await assertFilterOwnership(customerId, filterId);
  } catch (err) {
    if (err instanceof FilterNotFoundError) return undefined;
    throw err;
  }

  if (fields.webhook_url !== undefined && current.channel !== "webhook") {
    throw new ChannelMismatchError("este alerta entrega por email e nao tem webhook_url para atualizar");
  }

  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  const setExpressions: string[] = ["#updated_at = :now"];
  const names: Record<string, string> = { "#updated_at": "updated_at" };
  const values: Record<string, unknown> = { ":now": new Date().toISOString() };
  entries.forEach(([key, value], i) => {
    const nameKey = `#f${i}`;
    const valueKey = `:v${i}`;
    setExpressions.push(`${nameKey} = ${valueKey}`);
    names[nameKey] = key;
    values[valueKey] = value;
  });

  const res = await ddbDocClient.send(
    new UpdateCommand({
      TableName: SAVED_FILTERS_TABLE,
      Key: { customer_id: customerId, filter_id: filterId },
      UpdateExpression: `SET ${setExpressions.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }),
  );
  return parseSavedFilter(res.Attributes as Record<string, unknown>);
}

/**
 * Gera um webhook_secret NOVO (CSPRNG, mesmo padrao de createFilter) pro filtro do cliente --
 * util se o secret vazar. Nunca retorna o secret pro chamador (so internamente usado pelo
 * dispatcher de webhook pra assinar o HMAC do disparo, ver src/webhook/hmac.ts). So existe no
 * canal webhook: alerta por email nao assina nada.
 */
export async function regenerateFilterSecret(customerId: string, filterId: string): Promise<boolean> {
  let current: SavedFilter;
  try {
    current = await assertFilterOwnership(customerId, filterId);
  } catch (err) {
    if (err instanceof FilterNotFoundError) return false;
    throw err;
  }

  if (current.channel !== "webhook") {
    throw new ChannelMismatchError("alerta por email nao tem secret de assinatura para regenerar");
  }

  await ddbDocClient.send(
    new UpdateCommand({
      TableName: SAVED_FILTERS_TABLE,
      Key: { customer_id: customerId, filter_id: filterId },
      UpdateExpression: "SET webhook_secret = :secret, updated_at = :now",
      ExpressionAttributeValues: { ":secret": randomBytes(32).toString("hex"), ":now": new Date().toISOString() },
    }),
  );
  return true;
}
