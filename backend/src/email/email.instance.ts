import { env } from "../config/env";
import { createEmailConnector } from "./connectors/connector-registry";
import { EmailService } from "./email.service";

/**
 * Instancia unica usada pelo resto do backend: `import { emailService } from "../email/email.instance"`.
 * O provider vem de EMAIL_PROVIDER e e' resolvido aqui, uma vez, no import -- valor desconhecido
 * (typo no .env) derruba o processo no boot em vez de virar um email silenciosamente nao enviado
 * la na frente. Mesmo padrao de webhook-queue.instance.ts.
 */
export const emailService = new EmailService(createEmailConnector(env.emailProvider), {
  address: env.emailFromAddress,
  name: env.emailFromName,
});
