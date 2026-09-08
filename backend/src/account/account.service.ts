import { randomBytes } from "crypto";
import { hashApiKey } from "../common/auth/api-key.middleware";
import { ApiKeyRecord, PlanTier } from "../common/auth/types";
import { HttpError } from "../common/http-error";
import { PLANS } from "../billing/plans";
import { getMonthlyUsage, UsageStats } from "../mcp/usage.service";
import { getDailyUsageForLast30Days, last30DayDates } from "../common/usage-daily.repository";
import {
  createCustomer,
  createSubscription,
  getFirstPaymentForSubscription,
  getPixQrCode,
} from "../billing/asaas-client";
import { clearPendingCheckout, findAccountByCustomerId, putAccount, updateAccountFields } from "./account.repository";

export interface ProvisionResult {
  customer_id: string;
  email?: string;
  plan_tier: PlanTier;
  created_at: string;
  has_api_key: boolean;
  api_key?: string;
}

function generateApiKey(): { rawKey: string; apiKeyHash: string } {
  const rawKey = randomBytes(32).toString("hex");
  return { rawKey, apiKeyHash: hashApiKey(rawKey) };
}

/**
 * Idempotente: primeira chamada depois do signup cria a conta (plano Free) e devolve a API key
 * crua UMA UNICA VEZ (nem o backend guarda a crua depois disso, so o hash -- mesmo padrao do
 * resto do sistema, ver create-test-api-key.ts). Chamadas seguintes so devolvem o estado atual,
 * sem 'api_key' nenhuma (nunca expoe a chave de novo).
 */
export async function provisionAccount(customerId: string, email: string | undefined): Promise<ProvisionResult> {
  const existing = await findAccountByCustomerId(customerId);
  if (existing) {
    return {
      customer_id: existing.customer_id,
      email: existing.email ?? email,
      plan_tier: existing.plan_tier,
      created_at: existing.created_at,
      has_api_key: existing.active !== false,
    };
  }

  const { rawKey, apiKeyHash } = generateApiKey();
  const createdAt = new Date().toISOString();
  const record: ApiKeyRecord = {
    api_key_hash: apiKeyHash,
    customer_id: customerId,
    plan_tier: "free",
    active: true,
    created_at: createdAt,
    name: "Default",
    expires_at: null,
    email,
  };
  await putAccount(record);

  return {
    customer_id: customerId,
    email,
    plan_tier: "free",
    created_at: createdAt,
    has_api_key: true,
    api_key: rawKey,
  };
}

export interface AccountInfo {
  customer_id: string;
  email?: string;
  plan_tier: PlanTier;
  created_at: string;
  has_api_key: boolean;
}

export async function getAccountInfo(customerId: string): Promise<AccountInfo> {
  const existing = await findAccountByCustomerId(customerId);
  if (!existing) {
    throw new HttpError(404, "conta nao provisionada -- chame POST /v1/account/provision primeiro", "ACCOUNT_NOT_PROVISIONED");
  }
  return {
    customer_id: existing.customer_id,
    email: existing.email,
    plan_tier: existing.plan_tier,
    created_at: existing.created_at,
    has_api_key: existing.active !== false,
  };
}

export async function getAccountUsage(customerId: string): Promise<UsageStats> {
  const existing = await findAccountByCustomerId(customerId);
  if (!existing) {
    throw new HttpError(404, "conta nao provisionada -- chame POST /v1/account/provision primeiro", "ACCOUNT_NOT_PROVISIONED");
  }
  return getMonthlyUsage(customerId, existing.plan_tier);
}

export interface CheckoutInput {
  plan: PlanTier;
  cpfCnpj: string;
  name: string;
}

export interface CheckoutResult {
  plan: PlanTier;
  checkout_url: string;
  pix_qr_code?: { encoded_image: string; payload: string; expiration_date?: string };
  asaas_subscription_id: string;
}

const CHECKOUT_PLANS: readonly PlanTier[] = ["starter", "pro"];

/**
 * Cria (ou reusa) o customer do Asaas do cliente e uma assinatura recorrente pro plano escolhido.
 * cpfCnpj e' obrigatorio na API do Asaas pra criar um customer (confirmado na doc oficial) -- o
 * frontend precisa coletar isso (junto com o nome) numa etapa antes de chamar esta rota; nao da
 * pra inferir a partir do Cognito (so tem sub/email). billingType da assinatura e' sempre
 * "UNDEFINED" (ver asaas-client.ts::createSubscription) -- o cliente escolhe boleto/cartao/Pix na
 * fatura hospedada; devolvemos o invoiceUrl sempre, e o QR code Pix quando disponivel.
 */
export async function startCheckout(customerId: string, input: CheckoutInput): Promise<CheckoutResult> {
  if (!CHECKOUT_PLANS.includes(input.plan)) {
    throw new HttpError(400, "plan deve ser 'starter' ou 'pro'", "VALIDATION_ERROR");
  }
  const digits = (input.cpfCnpj ?? "").replace(/\D/g, "");
  if (digits.length !== 11 && digits.length !== 14) {
    throw new HttpError(400, "cpfCnpj deve ser um CPF (11 digitos) ou CNPJ (14 digitos) valido", "VALIDATION_ERROR");
  }
  if (!input.name || input.name.trim().length === 0) {
    throw new HttpError(400, "name e' obrigatorio", "VALIDATION_ERROR");
  }

  const existing = await findAccountByCustomerId(customerId);
  if (!existing) {
    throw new HttpError(404, "conta nao provisionada -- chame POST /v1/account/provision primeiro", "ACCOUNT_NOT_PROVISIONED");
  }

  let asaasCustomerId = existing.asaas_customer_id;
  if (!asaasCustomerId) {
    const customer = await createCustomer({
      name: input.name,
      cpfCnpj: digits,
      email: existing.email,
      externalReference: customerId,
    });
    asaasCustomerId = customer.id;
    await updateAccountFields(existing.api_key_hash, { asaas_customer_id: asaasCustomerId });
  }

  const plan = PLANS[input.plan];
  const subscription = await createSubscription({
    customer: asaasCustomerId,
    value: plan.priceBrl,
    nextDueDate: new Date().toISOString().slice(0, 10),
    cycle: "MONTHLY",
    description: `Assinatura LicitaHawk - plano ${plan.name}`,
    externalReference: customerId,
  });

  const firstPayment = await getFirstPaymentForSubscription(subscription.id);
  if (!firstPayment) {
    throw new HttpError(502, "Asaas nao gerou a primeira cobranca da assinatura", "ASAAS_ERROR");
  }

  await updateAccountFields(existing.api_key_hash, {
    asaas_subscription_id: subscription.id,
    pending_plan_tier: input.plan,
    checkout_invoice_url: firstPayment.invoiceUrl,
  });

  let pixQrCode: CheckoutResult["pix_qr_code"];
  try {
    const pix = await getPixQrCode(firstPayment.id);
    pixQrCode = { encoded_image: pix.encodedImage, payload: pix.payload, expiration_date: pix.expirationDate };
  } catch {
    // Pix nem sempre disponivel/pronto no instante da criacao (ex.: conta sem Pix habilitado) --
    // nao bloqueia o checkout, o invoiceUrl (fatura hospedada) sempre cobre esse caso.
  }

  return {
    plan: input.plan,
    checkout_url: firstPayment.invoiceUrl,
    pix_qr_code: pixQrCode,
    asaas_subscription_id: subscription.id,
  };
}

export interface SubscriptionStatus {
  plan_tier: PlanTier;
  pending_plan_tier: PlanTier | null;
  checkout_url: string | null;
}

/**
 * Leitura pura pro frontend fazer polling apos o checkout. Quem de fato promove plan_tier e' o
 * webhook do Asaas (asaas-webhook.router.ts, ja existente) quando o pagamento e' confirmado --
 * esta rota so reflete o estado atual. Quando plan_tier ja bateu com pending_plan_tier (pagamento
 * confirmado, polling pode parar), limpa os campos de checkout em aberto (best-effort).
 */
export async function getSubscriptionStatus(customerId: string): Promise<SubscriptionStatus> {
  const existing = await findAccountByCustomerId(customerId);
  if (!existing) {
    throw new HttpError(404, "conta nao provisionada -- chame POST /v1/account/provision primeiro", "ACCOUNT_NOT_PROVISIONED");
  }

  if (existing.pending_plan_tier && existing.pending_plan_tier === existing.plan_tier) {
    await clearPendingCheckout(existing.api_key_hash);
    return { plan_tier: existing.plan_tier, pending_plan_tier: null, checkout_url: null };
  }

  return {
    plan_tier: existing.plan_tier,
    pending_plan_tier: existing.pending_plan_tier ?? null,
    checkout_url: existing.checkout_invoice_url ?? null,
  };
}

export interface DailyUsageDay {
  date: string;
  api_count: number;
  mcp_count: number;
  ui_count: number;
  webhook_count: number;
  email_count: number;
  total_count: number;
}

export interface DailyUsageTotals {
  api: number;
  mcp: number;
  ui: number;
  webhook: number;
  email: number;
}

export interface DailyUsageResponse {
  days: DailyUsageDay[];
  totals: DailyUsageTotals;
}

/**
 * Uso diario (API/MCP/UI/Webhook) dos ultimos 30 dias, pros graficos do dashboard --
 * zero-preenchido pros dias sem requisicao (senao o grafico teria buraco). Nao exige conta
 * provisionada: se o customer_id nunca gerou trafego, UsageDaily simplesmente nao tem linha
 * nenhuma pra ele e o resultado vem zerado, o que ja e' a resposta correta.
 */
export async function getAccountDailyUsage(customerId: string): Promise<DailyUsageResponse> {
  const dates = last30DayDates();
  const rows = await getDailyUsageForLast30Days(customerId);

  const totals: DailyUsageTotals = { api: 0, mcp: 0, ui: 0, webhook: 0, email: 0 };
  const days: DailyUsageDay[] = dates.map((date) => {
    const row = rows.get(date) ?? { api_count: 0, mcp_count: 0, ui_count: 0, webhook_count: 0, email_count: 0 };
    totals.api += row.api_count;
    totals.mcp += row.mcp_count;
    totals.ui += row.ui_count;
    totals.webhook += row.webhook_count;
    totals.email += row.email_count;
    return {
      date,
      api_count: row.api_count,
      mcp_count: row.mcp_count,
      ui_count: row.ui_count,
      webhook_count: row.webhook_count,
      email_count: row.email_count,
      total_count: row.api_count + row.mcp_count + row.ui_count + row.webhook_count + row.email_count,
    };
  });

  return { days, totals };
}
