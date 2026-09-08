import { FocusNfseResponse, NfsePayload } from "./nfse-payload";

export type InvoiceStatus = "processando_autorizacao" | "autorizado" | "erro_autorizacao" | "cancelado";

export class FocusApiError extends Error {
  constructor(
    message: string,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = "FocusApiError";
  }
}

/**
 * Nunca lê FOCUS_ENV=producao como padrão implícito: qualquer valor diferente de
 * "producao" (incluindo ausente/typo) cai em homologacao. Fail-safe pro lado
 * errado seria o oposto (defaultar pra producao), o que é inaceitável aqui.
 */
function focusEnv(): "homologacao" | "producao" {
  return process.env.FOCUS_ENV === "producao" ? "producao" : "homologacao";
}

function baseUrl(): string {
  return focusEnv() === "producao" ? "https://api.focusnfe.com.br" : "https://homologacao.focusnfe.com.br";
}

function token(): string {
  const env = focusEnv();
  const value = env === "producao" ? process.env.FOCUS_TOKEN : process.env.FOCUS_TOKEN_HOMOLOGACAO;
  if (!value) {
    throw new Error(`Token do Focus NFe (${env}) nao configurado no .env`);
  }
  return value;
}

/** Auth Basic do Focus: token como usuario, senha vazia, base64. */
function authHeaders(): Record<string, string> {
  const basic = Buffer.from(`${token()}:`).toString("base64");
  return { Authorization: `Basic ${basic}`, "Content-Type": "application/json" };
}

/** POST /v2/nfse?ref=... */
export async function emitNfse(ref: string, payload: NfsePayload): Promise<FocusNfseResponse> {
  const url = `${baseUrl()}/v2/nfse?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as FocusNfseResponse;
  if (!res.ok) {
    throw new FocusApiError(`Focus /v2/nfse retornou HTTP ${res.status}`, data);
  }
  return data;
}

/** GET /v2/nfse/{ref} -- consulta status de autorizacao. */
export async function consultarNfse(ref: string): Promise<FocusNfseResponse> {
  const url = `${baseUrl()}/v2/nfse/${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: authHeaders() });
  const data = (await res.json().catch(() => ({}))) as FocusNfseResponse;
  if (!res.ok) {
    throw new FocusApiError(`Focus GET /v2/nfse/${ref} retornou HTTP ${res.status}`, data);
  }
  return data;
}

export function mapFocusStatus(status?: string): InvoiceStatus {
  switch (status) {
    case "autorizado":
      return "autorizado";
    case "erro_autorizacao":
      return "erro_autorizacao";
    case "cancelado":
      return "cancelado";
    case "processando_autorizacao":
    default:
      return "processando_autorizacao";
  }
}

export function describeFocusError(err: unknown): string {
  if (err instanceof FocusApiError) {
    const data = err.details as FocusNfseResponse | undefined;
    const focusMsg = data?.erros?.map((e) => e.mensagem).join("; ") ?? data?.mensagem;
    return focusMsg ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Header que a config do webhook do Focus foi cadastrada pra usar (default "Authorization", ver .env.example). */
export function focusWebhookHeaderName(): string {
  return process.env.FOCUS_WEBHOOK_HEADER || "Authorization";
}

export function focusWebhookExpectedToken(): string | undefined {
  const env = focusEnv();
  return env === "producao"
    ? process.env.FOCUS_WEBHOOK_TOKEN_PRODUCAO
    : process.env.FOCUS_WEBHOOK_TOKEN_HOMOLOGACAO;
}
