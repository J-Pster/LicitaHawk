import { EmailAddress, EmailPort, EmailSendResult, OutboundEmail } from "../../common/ports/email-port";
import { EmailDeliveryError } from "../email.errors";

/**
 * Connector do ZeptoMail (Zoho) pela API HTTP, nao por SMTP. Motivo da escolha: a API devolve
 * `request_id` e um corpo de erro estruturado (`error.code` + `error.details[]`), entao uma falha
 * vira log acionavel; SMTP devolve um codigo numerico e um texto livre. Sem SDK de proposito --
 * o contrato e' um POST JSON, e `fetch` mantem o padrao dos outros clients do projeto
 * (asaas-client, focus-client) e uma dependencia a menos pra auditar.
 *
 * Docs: https://www.zoho.com/zeptomail/help/api/email-sending.html
 */

const PROVIDER = "zeptomail";
const DEFAULT_API_URL = "https://api.zeptomail.com/v1.1/email";
const TOKEN_PREFIX = "Zoho-enczapikey ";
const REQUEST_TIMEOUT_MS = 10_000;

interface ZeptoMailSuccessBody {
  request_id?: string;
  message?: string;
}

interface ZeptoMailErrorBody {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    details?: { code?: string; message?: string; target?: string }[];
  };
}

export class ZeptoMailConnector implements EmailPort {
  readonly name = PROVIDER;

  async send(email: OutboundEmail): Promise<EmailSendResult> {
    const res = await postToZeptoMail(toZeptoMailPayload(email));
    const rawBody = await res.text().catch(() => "");
    const body = parseJsonOrUndefined(rawBody);

    if (!res.ok) {
      throw toDeliveryError(res.status, body, rawBody);
    }
    return { provider: PROVIDER, providerMessageId: (body as ZeptoMailSuccessBody | undefined)?.request_id };
  }
}

async function postToZeptoMail(payload: Record<string, unknown>) {
  try {
    return await fetch(apiUrl(), {
      method: "POST",
      headers: {
        authorization: authorizationHeader(),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
      // I/O externo: sem teto, um provider lento segura um request da API (ou um job do
      // scheduler) por tempo indeterminado.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    // Rede fora ou timeout estourado: traduz pro erro do dominio em vez de vazar
    // DOMException/TypeError do fetch pra quem so queria mandar um email.
    throw new EmailDeliveryError(
      `falha de rede ao chamar a API do ZeptoMail: ${(cause as Error).message}`,
      PROVIDER,
    );
  }
}

function apiUrl(): string {
  return process.env.ZEPTOMAIL_API_URL || DEFAULT_API_URL;
}

function authorizationHeader(): string {
  const raw = process.env.ZEPTOMAIL_TOKEN?.trim();
  if (!raw) {
    throw new Error('ZEPTOMAIL_TOKEN nao configurado no .env (EMAIL_PROVIDER="zeptomail")');
  }
  // O painel do ZeptoMail mostra o token ja com o prefixo, mas e' facil colar so a chave --
  // aceitar as duas formas evita um 401 que so apareceria no primeiro envio real.
  return raw.startsWith(TOKEN_PREFIX) ? raw : `${TOKEN_PREFIX}${raw}`;
}

function toZeptoMailPayload(email: OutboundEmail): Record<string, unknown> {
  return {
    from: toZeptoMailAddress(email.from),
    to: email.to.map((address) => ({ email_address: toZeptoMailAddress(address) })),
    subject: email.subject,
    ...(email.html ? { htmlbody: email.html } : {}),
    ...(email.text ? { textbody: email.text } : {}),
    ...(email.replyTo?.length ? { reply_to: email.replyTo.map(toZeptoMailAddress) } : {}),
    ...(email.clientReference ? { client_reference: email.clientReference } : {}),
  };
}

function toZeptoMailAddress(address: EmailAddress): { address: string; name?: string } {
  return address.name ? { address: address.address, name: address.name } : { address: address.address };
}

function parseJsonOrUndefined(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // Corpo nao-JSON (ex.: pagina de erro de gateway). O texto cru ainda vai na mensagem do erro
    // la embaixo, entao nada se perde.
    return undefined;
  }
}

function toDeliveryError(status: number, body: unknown, rawBody: string): EmailDeliveryError {
  const error = (body as ZeptoMailErrorBody | undefined)?.error;
  const details = error?.details
    ?.map((d) => `${d.code ?? "?"}${d.target ? ` (${d.target})` : ""}: ${d.message ?? ""}`)
    .join("; ");
  const message = error?.message ?? rawBody.slice(0, 500);

  return new EmailDeliveryError(
    `ZeptoMail recusou o envio (HTTP ${status}): ${message}${details ? ` -- ${details}` : ""}`,
    PROVIDER,
    { status, providerCode: error?.code, providerRequestId: error?.request_id },
  );
}
