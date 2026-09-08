import { Router } from "express";
import { AsaasPaymentWebhookPayload, AsaasWebhookBody } from "./asaas-types";
import { emitInvoiceForSubscriptionPayment } from "./invoice-emitter";
import { isAuthorized } from "./security";
import { downgradeToFreeForAsaasCustomer } from "./customer-plan-sync";
import { opsAlert } from "../common/ops-alert";
import { asyncHandler } from "../common/async-handler";

export const asaasWebhookRouter = Router();

// Eventos que representam pagamento confirmado -- os unicos que disparam emissao de NF-e.
// PAYMENT_CONFIRMED = cartao/boleto compensado; PAYMENT_RECEIVED = valor recebido (inclui Pix).
const PAYMENT_CONFIRMED_EVENTS = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"]);

// Bug real encontrado nesta rodada: o webhook so tratava confirmacao de pagamento (upgrade),
// nunca reversao financeira -- um estorno, chargeback ou cobranca deletada no Asaas nao mudava
// plan_tier NENHUM, entao o cliente continuava com acesso Pro/Starter de graca pra sempre depois
// de reaver o dinheiro. Rebaixa pra Free nesses eventos (nao mexe na NF-e ja emitida -- estorno
// fiscal e' um fluxo separado, fora de escopo aqui). PAYMENT_OVERDUE (assinatura recorrente que
// falhou) e' tratado so como alerta, nao downgrade automatico -- decisao deliberada: cortar
// acesso na primeira falha de cobranca e' agressivo demais sem uma janela de tolerancia/dunning
// (backlog, nao existe ainda), mas o time precisa ficar sabendo que aconteceu.
const REVOKE_ACCESS_EVENTS = new Set([
  "PAYMENT_REFUNDED",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_DELETED",
]);

function isValidPayment(payment: unknown): payment is AsaasPaymentWebhookPayload {
  if (!payment || typeof payment !== "object") return false;
  const p = payment as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    p.id.length > 0 &&
    typeof p.customer === "string" &&
    p.customer.length > 0 &&
    typeof p.value === "number" &&
    Number.isFinite(p.value) &&
    p.value >= 0
  );
}

asaasWebhookRouter.post(
  "/webhooks/asaas",
  asyncHandler(async (req, res) => {
    const received = req.get("asaas-access-token") ?? undefined;
    const expected = process.env.ASAAS_WEBHOOK_TOKEN;

    // CRITICO: fail-closed. Token ausente ou incorreto -> 403, sem tocar em plano nem NF-e.
    if (!isAuthorized(received, expected, "webhooks/asaas")) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "forbidden" } });
    }

    const body = req.body as AsaasWebhookBody;
    const event = body?.event;
    const payment = body?.payment;

    if (!event || !payment) {
      console.warn("[asaas-webhook] payload sem event/payment, ignorado");
      return res.status(200).json({ received: true });
    }

    // Validacao de entrada (Rodada 4): antes disso, um payload com `value` nao-numerico ou
    // `customer`/`id` ausente so quebrava mais adiante (ex.: planByPriceBrl(NaN) ou um
    // GetCommand com chave undefined) de forma menos clara. Responde 400 explicito no formato
    // padrao -- ainda 200 seria aceitavel pro Asaas nao reenviar em loop, mas um payload
    // malformado vindo de "asaas-access-token" valido e' sinal de bug de integracao (versao de
    // API mudou, etc.), vale ficar visivel como erro de verdade, nao engolido silenciosamente.
    if (!isValidPayment(payment)) {
      const raw = payment as Record<string, unknown>;
      console.error("[asaas-webhook] payload de payment invalido/incompleto, rejeitado", {
        event,
        hasId: typeof raw?.id,
        hasCustomer: typeof raw?.customer,
        hasValue: typeof raw?.value,
      });
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "payload de payment invalido ou incompleto" },
      });
    }

    if (REVOKE_ACCESS_EVENTS.has(event)) {
      const result = await downgradeToFreeForAsaasCustomer(payment.customer, event);
      return res.status(200).json({ received: true, downgraded: result.updatedCount > 0 });
    }

    if (event === "PAYMENT_OVERDUE") {
      opsAlert("billing_payment_overdue", "warning", {
        asaas_customer_id: payment.customer,
        asaas_payment_id: payment.id,
      });
      return res.status(200).json({ received: true, ignored: true });
    }

    if (!PAYMENT_CONFIRMED_EVENTS.has(event)) {
      return res.status(200).json({ received: true, ignored: true });
    }

    try {
      const result = await emitInvoiceForSubscriptionPayment(payment);
      return res.status(200).json({ received: true, invoice_ref: result.ref, status: result.status });
    } catch (err) {
      // 200 pro Asaas de qualquer forma -- o pagamento ja foi confirmado de verdade, nao
      // faz sentido o Asaas reenviar o webhook em loop por causa de uma falha nossa na
      // emissao. A falha fica registrada no proprio Invoice (status erro_autorizacao) pra
      // acompanhamento manual/alarme (Risco #14 do plano), e agora tambem via opsAlert.
      opsAlert("billing_nfse_emission_failed", "critical", {
        asaas_payment_id: payment.id,
        asaas_customer_id: payment.customer,
        error: (err as Error).message,
      });
      console.error("[asaas-webhook] falha ao emitir NF-e para pagamento", payment.id, err);
      return res.status(200).json({ received: true, invoice_emission_failed: true });
    }
  }),
);
