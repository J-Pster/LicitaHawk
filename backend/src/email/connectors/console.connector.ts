import { randomUUID } from "crypto";
import { EmailPort, EmailSendResult, OutboundEmail } from "../../common/ports/email-port";

/**
 * Connector de desenvolvimento: nao envia nada, so imprime uma linha JSON com o que teria saido.
 * E' o default quando EMAIL_PROVIDER nao esta setado, pra que rodar a API local (ou uma suite de
 * teste) nunca dispare email de verdade por descuido -- mesmo raciocinio do default sandbox do
 * asaas-client. O corpo nao vai pro log de proposito: pode ter dado de cliente.
 */
export class ConsoleEmailConnector implements EmailPort {
  readonly name = "console";

  async send(email: OutboundEmail): Promise<EmailSendResult> {
    const providerMessageId = randomUUID();
    const line = {
      email_console: true,
      id: providerMessageId,
      from: email.from.address,
      to: email.to.map((t) => t.address),
      subject: email.subject,
      has_html: Boolean(email.html),
      has_text: Boolean(email.text),
      client_reference: email.clientReference,
    };
    console.log(`[email:console] ${JSON.stringify(line)}`);
    return { provider: this.name, providerMessageId };
  }
}
