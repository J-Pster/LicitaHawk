import {
  EmailAddress,
  EmailMessage,
  EmailPort,
  EmailSendResult,
  OutboundEmail,
} from "../common/ports/email-port";
import { EmailValidationError } from "./email.errors";

// Regex frouxa de proposito: aqui nao se julga se o endereco existe (so o envio responde isso),
// so se barra o que quebraria o payload do provider -- vazio, sem @, com espaco no meio.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Servico compartilhado de envio de email: valida a mensagem uma vez, resolve o remetente default
 * e delega ao connector configurado. Nao sabe (nem pode saber) qual provider esta em uso -- essa
 * escolha mora em email.instance.ts.
 *
 * A validacao acontece aqui e so aqui porque este e' o boundary real: o destinatario quase sempre
 * vem de dado guardado (DynamoDB nao valida nada por nos, house rule do projeto) e o payload sai
 * daqui para um sistema externo que rejeita o request inteiro se um endereco estiver torto.
 */
export class EmailService {
  constructor(
    private readonly connector: EmailPort,
    private readonly defaultFrom: EmailAddress,
  ) {}

  get providerName(): string {
    return this.connector.name;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    return this.connector.send(this.toOutbound(message));
  }

  private toOutbound(message: EmailMessage): OutboundEmail {
    const from = message.from ?? this.defaultFrom;
    assertValidAddress(from, "from");

    if (message.to.length === 0) {
      throw new EmailValidationError("email sem destinatario: `to` vazio");
    }
    message.to.forEach((to, i) => assertValidAddress(to, `to[${i}]`));
    message.replyTo?.forEach((replyTo, i) => assertValidAddress(replyTo, `replyTo[${i}]`));

    if (message.subject.trim().length === 0) {
      throw new EmailValidationError("email sem assunto");
    }
    if (!message.html?.trim() && !message.text?.trim()) {
      throw new EmailValidationError("email sem corpo: informe `html`, `text` ou os dois");
    }

    return { ...message, from };
  }
}

function assertValidAddress(addr: EmailAddress, field: string): void {
  if (!EMAIL_RE.test(addr.address)) {
    throw new EmailValidationError(`endereco de email invalido em ${field}: '${addr.address}'`);
  }
}
