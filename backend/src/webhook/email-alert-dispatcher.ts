import { TenderMatchedPayload } from "../common/ports/alert-queue-port";
import { findAccountByCustomerId } from "../account/account.repository";
import { emailService } from "../email/email.instance";
import { EmailDeliveryError, EmailValidationError } from "../email/email.errors";
import { DispatchResult } from "./webhook-dispatcher";
import { renderTenderMatchedEmail } from "./tender-matched.email";

/**
 * Entrega de alerta pelo canal email. Espelha `dispatchWebhook`: mesmo `DispatchResult`, pra que a
 * fila (in-memory-alert-queue.adapter.ts) trate os dois canais com o mesmo retry, o mesmo circuit
 * breaker e o mesmo log de entregas -- a politica de entrega e' uma so, o transporte e' que muda.
 *
 * O destinatario e' resolvido aqui, no envio, e nao no job: a fonte da verdade e' o email da conta.
 */
export async function dispatchAlertEmail(
  customerId: string,
  payload: TenderMatchedPayload,
): Promise<DispatchResult> {
  const account = await findAccountByCustomerId(customerId);
  if (!account?.email) {
    // Nao ha para onde entregar. Erro definitivo (retry nao muda nada), mas conta como falha do
    // filtro igual qualquer outra: o circuit breaker acaba desativando o alerta, que e' o
    // comportamento certo pra uma conta sem email utilizavel.
    return { success: false, error: "conta sem email cadastrado -- nao ha destinatario para o alerta" };
  }

  const { subject, html, text } = renderTenderMatchedEmail(payload);

  try {
    await emailService.send({
      to: [{ address: account.email }],
      subject,
      html,
      text,
      clientReference: `${payload.filter_id}:${payload.tender.pncp_control_number}`,
    });
    // Sem status HTTP proprio: o log de entregas grava status_code null pro canal email, que e'
    // mais honesto que inventar um 200.
    return { success: true };
  } catch (err) {
    if (err instanceof EmailDeliveryError) {
      return { success: false, statusCode: err.details.status, error: err.message };
    }
    if (err instanceof EmailValidationError) {
      return { success: false, error: err.message };
    }
    throw err;
  }
}
