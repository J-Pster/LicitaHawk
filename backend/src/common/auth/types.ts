export type PlanTier = "free" | "starter" | "pro";

export interface ApiKeyRecord {
  api_key_hash: string;
  customer_id: string;
  plan_tier: PlanTier;
  active?: boolean;
  created_at: string;
  // Nome dado pelo cliente pra essa chave (ex.: "Servidor de producao", "Script de teste") --
  // suporte a MULTIPLAS chaves nomeadas por customer_id (POST /v1/account/api-keys), substitui
  // o modelo antigo de 1 chave ativa por cliente. "Default" pra chave criada em
  // POST /v1/account/provision.
  name: string;
  // Data de expiracao ISO 8601 opcional -- `authenticate` (api-key.middleware.ts) rejeita com
  // 401 se preenchida e no passado. null = nunca expira.
  expires_at: string | null;
  // Linka esse ApiKeyRecord a um customer do Asaas -- usado por
  // billing/customer-plan-sync.ts (via GSI-asaas-customer-id) pra saber qual registro
  // atualizar quando um pagamento e' confirmado. Sem esse campo preenchido, pagamento
  // confirmado nao consegue atualizar plan_tier automaticamente (ver aviso de log).
  asaas_customer_id?: string;
  // Campos do fluxo de checkout (src/account/) -- preenchidos em POST /v1/account/checkout,
  // lidos por GET /v1/account/subscription pra o frontend saber se ha um checkout em aberto
  // (plan_tier so muda de verdade quando o webhook do Asaas confirma o pagamento).
  asaas_subscription_id?: string;
  pending_plan_tier?: PlanTier;
  checkout_invoice_url?: string;
  // Email do usuario no Cognito (claim 'email' do ID token) -- espelhado aqui em
  // POST /v1/account/provision so pra GET /v1/account/me responder sem precisar
  // re-consultar o Cognito a cada chamada.
  email?: string;
}

export interface AuthContext {
  customer_id: string;
  plan_tier: PlanTier;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};
