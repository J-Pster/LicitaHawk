import { Router } from "express";
import { focusWebhookExpectedToken, focusWebhookHeaderName, mapFocusStatus } from "./focus-client";
import { applyStatusUpdateGuarded } from "./invoice.repository";
import { FocusNfseResponse } from "./nfse-payload";
import { isAuthorized } from "./security";
import { asyncHandler } from "../common/async-handler";
import { opsAlert } from "../common/ops-alert";

export const focusWebhookRouter = Router();

focusWebhookRouter.post(
  "/webhooks/focus",
  asyncHandler(async (req, res) => {
  const headerName = focusWebhookHeaderName();
  const received = req.get(headerName) ?? undefined;
  const expected = focusWebhookExpectedToken();

  // Mesmo padrao fail-closed do webhook do Asaas -- segredo diferente (FOCUS_WEBHOOK_TOKEN_*),
  // nao confundir os dois.
  if (!isAuthorized(received, expected, "webhooks/focus")) {
    return res.status(403).json({ error: { code: "FORBIDDEN", message: "forbidden" } });
  }

  const body = req.body as FocusNfseResponse & { ref?: string };
  const ref = (req.query.ref as string | undefined) ?? body?.ref;
  if (!ref) {
    console.warn("[focus-webhook] callback sem ref, ignorado");
    return res.status(200).json({ received: true });
  }

  const nextStatus = mapFocusStatus(body.status);
  const errorMessage =
    nextStatus === "erro_autorizacao" ? (body.erros?.map((e) => e.mensagem).join("; ") ?? body.mensagem) : undefined;
  const { applied } = await applyStatusUpdateGuarded(ref, nextStatus, body, {
    numero: body.numero,
    codigoVerificacao: body.codigo_verificacao,
    pdfUrl: body.url_danfse ?? body.url,
    xmlUrl: body.caminho_xml_nota_fiscal,
    errorMessage,
  });

  if (!applied) {
    console.warn(
      `[focus-webhook] callback para ${ref} (status=${nextStatus}) ignorado -- guarda de estado terminal`,
    );
  } else if (nextStatus === "erro_autorizacao") {
    // Observabilidade real (item #4 do PLAN.md): antes disso, uma falha de autorizacao de NF-e
    // so aparecia como console.log solto, sem nenhum sinal estruturado pra alarme. Nao mexe no
    // payload/logica do Focus (Secao 12 do PLAN.md, investigacao fechada) -- so torna a falha
    // visivel.
    opsAlert("billing_nfse_authorization_failed", "critical", { ref, error: errorMessage });
  }

    return res.status(200).json({ received: true });
  }),
);
