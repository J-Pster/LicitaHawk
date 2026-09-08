// Cliente pra API real do Asaas. Nasceu so-leitura (Rodada 4, job de reconciliacao) e ganhou
// escrita (fluxo de checkout, src/account/) -- createCustomer/createSubscription. Sandbox
// (ASAAS_API_KEY_SANDBOX) chegou depois que o usuario criou a conta sandbox.asaas.com pra poder
// testar checkout sem tocar producao -- mesmo padrao ja usado no Focus NFe (FOCUS_ENV), inclusive
// no default seguro: ASAAS_ENV so vira "producao" com o valor EXATO "producao", qualquer outra
// coisa (ausente, "sandbox", typo) cai em sandbox. Nunca leia producao como padrao implicito.
export class AsaasApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AsaasApiError";
  }
}

function asaasEnv(): "sandbox" | "producao" {
  return process.env.ASAAS_ENV === "producao" ? "producao" : "sandbox";
}

function baseUrl(): string {
  return asaasEnv() === "producao" ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3";
}

function apiKey(): string {
  const env = asaasEnv();
  const key = env === "producao" ? process.env.ASAAS_API_KEY_PROD : process.env.ASAAS_API_KEY_SANDBOX;
  if (!key) {
    const varName = env === "producao" ? "ASAAS_API_KEY_PROD" : "ASAAS_API_KEY_SANDBOX";
    throw new Error(`${varName} nao configurado no .env (ASAAS_ENV=${env})`);
  }
  return key;
}

export interface AsaasPaymentListItem {
  id: string;
  customer: string;
  subscription?: string;
  value: number;
  status: string;
  paymentDate?: string;
  confirmedDate?: string;
}

interface AsaasListResponse<T> {
  object: "list";
  hasMore: boolean;
  totalCount: number;
  limit: number;
  offset: number;
  data: T[];
}

/**
 * Busca um unico pagamento por id, com o status MAIS RECENTE no Asaas. Usado pela reconciliacao
 * (Rodada 9) pra re-confirmar o status de um pagamento imediatamente antes de escrever plan_tier
 * -- fecha uma janela real de corrida (TOCTOU) entre a listagem inicial (que pode levar segundos/
 * minutos pra paginar) e a escrita: se um estorno/chargeback chegou via webhook nesse meio-tempo
 * (ver asaas-webhook.router.ts, downgradeToFreeForAsaasCustomer), o Asaas ja teria mudado o
 * status do pagamento pra REFUNDED/CHARGEBACK_* antes desta releitura, entao a reconciliacao
 * detecta e pula em vez de reescrever o tier pra cima com dado desatualizado.
 */
export async function getPaymentById(paymentId: string): Promise<AsaasPaymentListItem> {
  const res = await fetch(`${baseUrl()}/payments/${encodeURIComponent(paymentId)}`, {
    headers: { access_token: apiKey() },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AsaasApiError(`Asaas GET /payments/${paymentId} retornou HTTP ${res.status}: ${body}`, res.status);
  }
  return (await res.json()) as AsaasPaymentListItem;
}

/**
 * Lista pagamentos por status a partir de uma data, paginando ate esgotar. Usado pela
 * reconciliacao pra reler o estado real do Asaas e comparar com o que a base local tem -- pega o
 * gap de webhook nao entregue (Risco #13), independente de por que o webhook nao chegou (rede,
 * processo fora do ar no momento, etc.).
 *
 * Bug real corrigido: o filtro usava `paymentDate[ge]`, mas esse campo so e' preenchido pelo
 * Asaas pra boleto/Pix -- pagamento CONFIRMADO via CARTAO DE CREDITO fica com `paymentDate: null`
 * pra sempre (usa `confirmedDate`/`clientPaymentDate` em vez disso). Resultado: TODO pagamento
 * confirmado por cartao era invisivel pra essa query, silenciosamente, e a reconciliacao nunca
 * corrigia o `plan_tier` desses clientes se o webhook em tempo real falhasse -- reproduzido ao
 * vivo contra o sandbox (checkout pago com cartao de teste, reconciliacao rodou e devolveu
 * `checked: 0`). Trocado pra `dateCreated[ge]`, que o Asaas sempre preenche na criacao da
 * cobranca, independente do meio de pagamento escolhido depois.
 */
export async function listPaymentsByStatusSince(status: string, sinceDate: string): Promise<AsaasPaymentListItem[]> {
  const results: AsaasPaymentListItem[] = [];
  let offset = 0;
  const limit = 100;

  for (;;) {
    const url = `${baseUrl()}/payments?status=${encodeURIComponent(status)}&dateCreated[ge]=${encodeURIComponent(sinceDate)}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { access_token: apiKey() },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AsaasApiError(`Asaas GET /payments retornou HTTP ${res.status}: ${body}`, res.status);
    }
    const page = (await res.json()) as AsaasListResponse<AsaasPaymentListItem>;
    results.push(...page.data);
    if (!page.hasMore) break;
    offset += limit;
  }

  return results;
}

export interface AsaasCustomer {
  id: string;
  name: string;
  email?: string;
  cpfCnpj: string;
}

export interface CreateAsaasCustomerInput {
  name: string;
  cpfCnpj: string;
  email?: string;
  externalReference?: string;
}

/**
 * Cria um customer no Asaas (POST /v3/customers) -- 'cpfCnpj' e' obrigatorio na API do Asaas
 * (confirmado na doc oficial), diferente do resto do payload de pagamento (asaas-types.ts), que
 * so tem CPF/CNPJ opcional vindo do webhook. Por isso a rota de checkout (src/account/) exige
 * cpfCnpj no corpo da requisicao -- decisao de design documentada la, o frontend precisa coletar
 * esse dado antes de chamar o checkout.
 */
export async function createCustomer(input: CreateAsaasCustomerInput): Promise<AsaasCustomer> {
  const res = await fetch(`${baseUrl()}/customers`, {
    method: "POST",
    headers: { access_token: apiKey(), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AsaasApiError(`Asaas POST /customers retornou HTTP ${res.status}: ${body}`, res.status);
  }
  return (await res.json()) as AsaasCustomer;
}

export interface AsaasSubscription {
  id: string;
  customer: string;
  billingType: string;
  cycle: string;
  value: number;
  nextDueDate: string;
  status: string;
}

export interface CreateAsaasSubscriptionInput {
  customer: string;
  value: number;
  nextDueDate: string;
  cycle: string;
  description: string;
  externalReference?: string;
}

/**
 * Cria uma assinatura recorrente (POST /v3/subscriptions) com billingType "UNDEFINED" -- deixa o
 * cliente escolher a forma de pagamento (boleto, cartao ou Pix) na fatura hospedada pelo Asaas
 * (invoiceUrl), em vez do backend decidir por ele. E' o comportamento padrao recomendado pela doc
 * do Asaas quando a integracao quer aceitar mais de uma forma de pagamento sem construir um
 * formulario de cartao proprio (PCI). Ver getFirstPaymentForSubscription/getPixQrCode abaixo pra
 * como o checkout (src/account/) usa isso pra devolver o link de pagamento pro frontend.
 */
export async function createSubscription(input: CreateAsaasSubscriptionInput): Promise<AsaasSubscription> {
  const res = await fetch(`${baseUrl()}/subscriptions`, {
    method: "POST",
    headers: { access_token: apiKey(), "content-type": "application/json" },
    body: JSON.stringify({ ...input, billingType: "UNDEFINED" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AsaasApiError(`Asaas POST /subscriptions retornou HTTP ${res.status}: ${body}`, res.status);
  }
  return (await res.json()) as AsaasSubscription;
}

export interface AsaasPayment {
  id: string;
  customer: string;
  subscription?: string;
  value: number;
  status: string;
  billingType: string;
  invoiceUrl: string;
}

/**
 * Busca a primeira cobranca gerada pra uma assinatura recem-criada -- e' onde mora o invoiceUrl
 * (fatura hospedada pelo Asaas) que o checkout (src/account/) devolve pro frontend redirecionar o
 * cliente. Asaas gera a primeira cobranca de forma sincrona na criacao da assinatura, entao uma
 * unica pagina (limit=1, mais recente primeiro) e' suficiente logo em seguida.
 */
export async function getFirstPaymentForSubscription(subscriptionId: string): Promise<AsaasPayment | undefined> {
  const url = `${baseUrl()}/payments?subscription=${encodeURIComponent(subscriptionId)}&limit=1`;
  const res = await fetch(url, { headers: { access_token: apiKey() } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AsaasApiError(`Asaas GET /payments?subscription=${subscriptionId} retornou HTTP ${res.status}: ${body}`, res.status);
  }
  const page = (await res.json()) as AsaasListResponse<AsaasPayment>;
  return page.data[0];
}

export interface AsaasPixQrCode {
  encodedImage: string;
  payload: string;
  expirationDate?: string;
}

/**
 * QR code Pix de uma cobranca especifica (GET /v3/payments/{id}/pixQrCode). Funciona mesmo pra
 * cobranca criada com billingType "UNDEFINED" (Pix e' uma das opcoes disponiveis na fatura) --
 * usado pelo checkout pra enriquecer a resposta com QR code quando disponivel, sem forcar Pix
 * como unica forma de pagamento (ver createSubscription acima).
 */
export async function getPixQrCode(paymentId: string): Promise<AsaasPixQrCode> {
  const res = await fetch(`${baseUrl()}/payments/${encodeURIComponent(paymentId)}/pixQrCode`, {
    headers: { access_token: apiKey() },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AsaasApiError(`Asaas GET /payments/${paymentId}/pixQrCode retornou HTTP ${res.status}: ${body}`, res.status);
  }
  return (await res.json()) as AsaasPixQrCode;
}
