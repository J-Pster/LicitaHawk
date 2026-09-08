import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { ApiKeyRecord } from "../common/auth/types";

const API_KEYS_TABLE = "ApiKeys";
const GSI_CUSTOMER_ID = "GSI-customer-id";

/**
 * Encontra o ApiKeyRecord ATIVO de um customer_id (sub do Cognito) via GSI-customer-id -- e' como
 * as rotas de conta (account.router.ts) sabem "esse usuario Cognito ja tem conta provisionada?"
 * sem precisar saber o api_key_hash de antemao (a PK real da tabela).
 *
 * Bug real corrigido: regenerar a chave (deactivateApiKey) deixa 2+ itens com o mesmo customer_id
 * na GSI (o antigo desativado + o novo ativo). `Limit: 1` sem filtro podia pegar o item errado
 * (a query aplica o Limit ANTES do FilterExpression, entao um Limit:1 podia "gastar" o unico
 * resultado no item inativo e devolver undefined mesmo com uma chave ativa existindo). Sem sort
 * key na GSI pra garantir "mais recente primeiro", a solucao correta e' nunca truncar antes de
 * filtrar: busca todos os itens do customer (tipicamente 1-3, nunca demais pra paginar) e filtra
 * por `active` em memoria.
 */
export async function findAccountByCustomerId(customerId: string): Promise<ApiKeyRecord | undefined> {
  const res = await ddbDocClient.send(
    new QueryCommand({
      TableName: API_KEYS_TABLE,
      IndexName: GSI_CUSTOMER_ID,
      KeyConditionExpression: "customer_id = :cid",
      ExpressionAttributeValues: { ":cid": customerId },
    }),
  );
  const items = (res.Items ?? []) as ApiKeyRecord[];
  return items.find((item) => item.active) ?? items[0];
}

/**
 * Todas as linhas (ativas e revogadas) de um customer_id -- diferente de
 * findAccountByCustomerId (que devolve so UMA, a ativa/mais provavel), usada por
 * src/account/api-keys.service.ts pra listar TODAS as chaves nomeadas do cliente.
 */
export async function listAllAccountKeys(customerId: string): Promise<ApiKeyRecord[]> {
  const res = await ddbDocClient.send(
    new QueryCommand({
      TableName: API_KEYS_TABLE,
      IndexName: GSI_CUSTOMER_ID,
      KeyConditionExpression: "customer_id = :cid",
      ExpressionAttributeValues: { ":cid": customerId },
    }),
  );
  return (res.Items ?? []) as ApiKeyRecord[];
}

export async function getAccountByApiKeyHash(apiKeyHash: string): Promise<ApiKeyRecord | undefined> {
  const res = await ddbDocClient.send(new GetCommand({ TableName: API_KEYS_TABLE, Key: { api_key_hash: apiKeyHash } }));
  return res.Item as ApiKeyRecord | undefined;
}

export async function putAccount(record: ApiKeyRecord): Promise<void> {
  await ddbDocClient.send(new PutCommand({ TableName: API_KEYS_TABLE, Item: record }));
}

export async function updateAccountFields(apiKeyHash: string, fields: Partial<ApiKeyRecord>): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;

  const setExpressions: string[] = [];
  const values: Record<string, unknown> = {};
  const names: Record<string, string> = {};
  entries.forEach(([key, value], i) => {
    const nameKey = `#f${i}`;
    const valueKey = `:v${i}`;
    setExpressions.push(`${nameKey} = ${valueKey}`);
    names[nameKey] = key;
    values[valueKey] = value;
  });

  await ddbDocClient.send(
    new UpdateCommand({
      TableName: API_KEYS_TABLE,
      Key: { api_key_hash: apiKeyHash },
      UpdateExpression: `SET ${setExpressions.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Desativa a chave antiga (nao deleta -- historico/auditoria) ao regenerar. `active: false` ja
 * e' o mesmo campo que `authenticate` (api-key.middleware.ts) checa pra rejeitar a chave.
 */
export async function deactivateApiKey(apiKeyHash: string): Promise<void> {
  await updateAccountFields(apiKeyHash, { active: false });
}

/**
 * Remove (REMOVE, nao SET null) os campos de checkout em aberto quando o pagamento ja foi
 * confirmado (plan_tier ja bateu com pending_plan_tier) -- usado por
 * account.service.ts::getSubscriptionStatus pra o frontend parar de ver um checkout "pendente"
 * que ja terminou.
 */
export async function clearPendingCheckout(apiKeyHash: string): Promise<void> {
  await ddbDocClient.send(
    new UpdateCommand({
      TableName: API_KEYS_TABLE,
      Key: { api_key_hash: apiKeyHash },
      UpdateExpression: "REMOVE pending_plan_tier, checkout_invoice_url",
    }),
  );
}
