/**
 * Port de envio de email. O resto do backend (billing, alerta operacional, onboarding) depende
 * so desta interface -- nunca de um SDK, de uma URL de provider ou de um token. Trocar ZeptoMail
 * por SES/Resend/Postmark, ou usar dois providers ao mesmo tempo, e' escrever um connector novo
 * em src/email/connectors/ e registrar o nome no connector-registry: nenhum chamador muda.
 */

export interface EmailAddress {
  address: string;
  name?: string;
}

/** O que um chamador pede. `from` ausente cai no remetente default do .env (EMAIL_FROM_*). */
export interface EmailMessage {
  to: EmailAddress[];
  subject: string;
  html?: string;
  text?: string;
  from?: EmailAddress;
  replyTo?: EmailAddress[];
  /** Id nosso (ex.: invoice_id) pra cruzar com o log do provider quando algo nao chegar. */
  clientReference?: string;
}

/**
 * Mensagem ja validada, com remetente resolvido -- e' o unico formato que um connector recebe.
 * O tipo carrega a garantia: connector nao re-valida endereco nem preenche default (parse,
 * don't validate). Quem produz um OutboundEmail e' o EmailService, ponto.
 */
export type OutboundEmail = Omit<EmailMessage, "from"> & { from: EmailAddress };

export interface EmailSendResult {
  provider: string;
  /** Id/request id devolvido pelo provider. Ausente em connector que nao expoe um. */
  providerMessageId?: string;
}

export interface EmailPort {
  readonly name: string;
  send(email: OutboundEmail): Promise<EmailSendResult>;
}
