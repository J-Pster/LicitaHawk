import { randomUUID } from "node:crypto";
import { AsaasPaymentWebhookPayload } from "./asaas-types";
import { describeFocusError, emitNfse, InvoiceStatus, mapFocusStatus } from "./focus-client";
import { applyStatusUpdateGuarded, createInvoice } from "./invoice.repository";
import { BillingTomador, buildNfsePayload } from "./nfse-payload";
import { planByPriceBrl } from "./plans";
import { upgradePlanForAsaasCustomer } from "./customer-plan-sync";

export interface EmitInvoiceResult {
  ref: string;
  status: InvoiceStatus;
}

/**
 * Fluxo completo do item 5.5 do plano: pagamento de assinatura confirmado no
 * Asaas -> monta payload -> emite NFS-e no Focus (FOCUS_ENV controla
 * homologacao/producao) -> persiste o registro com a guarda de estado
 * terminal desde a primeira escrita.
 */
export async function emitInvoiceForSubscriptionPayment(
  payment: AsaasPaymentWebhookPayload,
): Promise<EmitInvoiceResult> {
  const plan = planByPriceBrl(payment.value);
  const tomador = extractTomador(payment);
  const ref = buildInvoiceRef(payment.id);
  const discriminacao = `Assinatura LicitaHawk${plan ? ` - plano ${plan.name}` : ""} - pagamento Asaas ${payment.id}`;

  const payload = buildNfsePayload({
    tomador,
    amountBrl: payment.value,
    discriminacao,
    dataEmissao: new Date(),
  });

  await createInvoice({
    ref,
    status: "processando_autorizacao",
    asaas_payment_id: payment.id,
    asaas_customer_id: payment.customer,
    asaas_subscription_id: payment.subscription,
    plan_tier: plan?.tier,
    amount_brl: payment.value,
    request_payload: payload,
  });

  // Achado real da revisao de qualidade: pagamento confirmado nunca atualizava o plan_tier real
  // do cliente. Atualiza AQUI (pagamento confirmado), independente do resultado da emissao de
  // NF-e abaixo -- o cliente pagou de verdade, o upgrade de limite de uso nao deve depender de o
  // Focus estar disponivel ou nao no momento.
  if (plan) {
    await upgradePlanForAsaasCustomer(payment.customer, plan.tier);
  } else {
    console.warn(`[billing] valor de pagamento ${payment.value} nao corresponde a nenhum plano conhecido`);
  }

  try {
    const response = await emitNfse(ref, payload);
    const status = mapFocusStatus(response.status);
    await applyStatusUpdateGuarded(ref, status, response, {
      numero: response.numero,
      codigoVerificacao: response.codigo_verificacao,
      pdfUrl: response.url_danfse ?? response.url,
      xmlUrl: response.caminho_xml_nota_fiscal,
      errorMessage:
        status === "erro_autorizacao"
          ? (response.erros?.map((e) => e.mensagem).join("; ") ?? response.mensagem)
          : undefined,
    });
    return { ref, status };
  } catch (err) {
    await applyStatusUpdateGuarded(ref, "erro_autorizacao", { error: describeFocusError(err) }, {
      errorMessage: describeFocusError(err),
    });
    throw err;
  }
}

function buildInvoiceRef(asaasPaymentId: string): string {
  // Sufixo aleatorio evita colisao se o mesmo pagamento gerar mais de uma tentativa
  // de emissao (ex.: reenvio manual apos falha) -- cada tentativa tem seu proprio ref.
  return `licitahawk-${asaasPaymentId}-${randomUUID().slice(0, 8)}`;
}

function extractTomador(payment: AsaasPaymentWebhookPayload): BillingTomador {
  const digits = (payment.customerCpfCnpj ?? "").replace(/\D/g, "");
  const tomador: BillingTomador = {
    razaoSocial: payment.customerName ?? `Cliente Asaas ${payment.customer}`,
    email: payment.customerEmail,
  };
  if (digits.length === 11) {
    tomador.cpf = digits;
  } else if (digits.length === 14) {
    tomador.cnpj = digits;
  }
  return tomador;
}
