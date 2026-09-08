import { randomBytes } from "crypto";
import { hashApiKey } from "../common/auth/api-key.middleware";
import { ApiKeyRecord } from "../common/auth/types";
import { HttpError } from "../common/http-error";
import {
  deactivateApiKey,
  findAccountByCustomerId,
  getAccountByApiKeyHash,
  listAllAccountKeys,
  putAccount,
  updateAccountFields,
} from "./account.repository";

// CRUD de multiplas API keys nomeadas por customer_id (substitui o modelo antigo de 1 chave
// ativa por cliente -- ver POST /v1/account/provision, que agora cria so a PRIMEIRA linha
// "Default"). `id` exposto ao cliente e' o proprio api_key_hash (nao reversivel, seguro expor
// como identificador -- mesmo criterio ja documentado em account.repository.ts).

export interface ApiKeySummary {
  id: string;
  name: string;
  created_at: string;
  expires_at: string | null;
  active: boolean;
}

export interface CreateApiKeyResult extends ApiKeySummary {
  api_key: string;
}

function generateApiKey(): { rawKey: string; apiKeyHash: string } {
  const rawKey = randomBytes(32).toString("hex");
  return { rawKey, apiKeyHash: hashApiKey(rawKey) };
}

function toSummary(record: ApiKeyRecord): ApiKeySummary {
  return {
    id: record.api_key_hash,
    name: record.name,
    created_at: record.created_at,
    expires_at: record.expires_at ?? null,
    active: record.active !== false,
  };
}

/** Valida um ISO 8601 opcional -- `undefined`/`null` vira "nunca expira" (null persistido). */
export function parseExpiresAt(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || Number.isNaN(new Date(raw).getTime())) {
    throw new HttpError(400, "'expires_at' deve ser uma data ISO 8601 valida ou null", "VALIDATION_ERROR");
  }
  return raw;
}

/**
 * Cria uma chave NOVA (nao substitui as existentes) -- plan_tier copiado do plano atual da
 * conta (qualquer linha existente do cliente ja reflete o plano real apos o fix de propagacao
 * em customer-plan-sync.ts, que agora atualiza TODAS as linhas ativas). Exige que a conta ja
 * tenha sido provisionada (POST /v1/account/provision) pelo menos uma vez.
 */
export async function createApiKey(customerId: string, name: string, expiresAt: string | null): Promise<CreateApiKeyResult> {
  const existing = await findAccountByCustomerId(customerId);
  if (!existing) {
    throw new HttpError(404, "conta nao provisionada -- chame POST /v1/account/provision primeiro", "ACCOUNT_NOT_PROVISIONED");
  }

  const { rawKey, apiKeyHash } = generateApiKey();
  const createdAt = new Date().toISOString();
  const record: ApiKeyRecord = {
    api_key_hash: apiKeyHash,
    customer_id: customerId,
    plan_tier: existing.plan_tier,
    active: true,
    created_at: createdAt,
    name,
    expires_at: expiresAt,
    email: existing.email,
    asaas_customer_id: existing.asaas_customer_id,
  };
  await putAccount(record);

  return { ...toSummary(record), api_key: rawKey };
}

export async function listApiKeys(customerId: string): Promise<ApiKeySummary[]> {
  const items = await listAllAccountKeys(customerId);
  return items
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map(toSummary);
}

/** Busca uma chave garantindo que pertence ao customer_id informado (protecao IDOR -- a PK real
 * da tabela e' so o api_key_hash, entao sem essa checagem qualquer cliente autenticado poderia
 * renomear/revogar a chave de outro so adivinhando/observando um hash alheio). */
async function getOwnedApiKey(customerId: string, apiKeyHash: string): Promise<ApiKeyRecord> {
  const record = await getAccountByApiKeyHash(apiKeyHash);
  if (!record || record.customer_id !== customerId) {
    throw new HttpError(404, "chave de API nao encontrada", "NOT_FOUND");
  }
  return record;
}

export interface UpdateApiKeyInput {
  name?: string;
  expires_at?: string | null;
}

export async function updateApiKey(customerId: string, apiKeyHash: string, fields: UpdateApiKeyInput): Promise<ApiKeySummary> {
  const record = await getOwnedApiKey(customerId, apiKeyHash);
  const updates: Partial<ApiKeyRecord> = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.expires_at !== undefined) updates.expires_at = fields.expires_at;

  if (Object.keys(updates).length > 0) {
    await updateAccountFields(apiKeyHash, updates);
  }

  return toSummary({ ...record, ...updates });
}

export async function revokeApiKey(customerId: string, apiKeyHash: string): Promise<void> {
  await getOwnedApiKey(customerId, apiKeyHash);
  await deactivateApiKey(apiKeyHash);
}
