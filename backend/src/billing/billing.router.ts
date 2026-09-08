import { Router } from "express";
import { asaasWebhookRouter } from "./asaas-webhook.router";
import { focusWebhookRouter } from "./focus-webhook.router";

// Router unico exportado pro team-lead montar em src/server.ts com `app.use(billingRouter)`.
// Ja inclui os paths completos (/webhooks/asaas, /webhooks/focus) -- nao precisa de prefixo.
export const billingRouter = Router();
billingRouter.use(asaasWebhookRouter);
billingRouter.use(focusWebhookRouter);
