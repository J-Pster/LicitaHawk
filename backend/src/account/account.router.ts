import { Router } from "express";
import { cognitoAuthenticate } from "../common/auth/cognito-auth.middleware";
import { asyncHandler } from "../common/async-handler";
import { HttpError } from "../common/http-error";
import { PlanTier } from "../common/auth/types";
import { env } from "../config/env";
import { MCP_TOOLS_INFO } from "../mcp/mcp.router";
import {
  getAccountDailyUsage,
  getAccountInfo,
  getAccountUsage,
  getSubscriptionStatus,
  provisionAccount,
  startCheckout,
} from "./account.service";
import { createApiKey, listApiKeys, parseExpiresAt, revokeApiKey, updateApiKey } from "./api-keys.service";

// Router de gestao de conta (ligacao Cognito <-> customer do produto). Autenticado por ID token
// do Cognito (cognitoAuthenticate), NAO por API key -- diferente de tenders/filters/webhook, que
// sao rotas de PRODUTO. Ver src/common/auth/cognito-auth.middleware.ts. Aplicado por rota (nunca
// via router.use() sem path), mesmo motivo documentado em tenders.router.ts.
export const accountRouter = Router();

accountRouter.post(
  "/v1/account/provision",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const { sub, email } = req.cognitoUser!;
    const result = await provisionAccount(sub, email);
    res.status(200).json({ data: result });
  }),
);

// Multiplas API keys nomeadas por conta (substitui o antigo POST /v1/account/api-key/regenerate,
// modelo de 1-chave-so). `id` na URL e' o api_key_hash (nao reversivel, seguro como identificador
// -- ver api-keys.service.ts).
accountRouter.post(
  "/v1/account/api-keys",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const { name, expires_at: expiresAtRaw } = (req.body ?? {}) as { name?: string; expires_at?: string | null };
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw new HttpError(400, "name e' obrigatorio", "VALIDATION_ERROR");
    }
    const expiresAt = parseExpiresAt(expiresAtRaw);
    const result = await createApiKey(req.cognitoUser!.sub, name.trim(), expiresAt);
    res.status(201).json({ data: result });
  }),
);

accountRouter.get(
  "/v1/account/api-keys",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const keys = await listApiKeys(req.cognitoUser!.sub);
    res.json({ data: keys });
  }),
);

accountRouter.patch(
  "/v1/account/api-keys/:id",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const { name, expires_at: expiresAtRaw } = (req.body ?? {}) as { name?: string; expires_at?: string | null };
    if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
      throw new HttpError(400, "name, quando informado, nao pode ser vazio", "VALIDATION_ERROR");
    }
    if (name === undefined && expiresAtRaw === undefined) {
      throw new HttpError(400, "informe ao menos 'name' ou 'expires_at' para atualizar", "VALIDATION_ERROR");
    }
    const fields: { name?: string; expires_at?: string | null } = {};
    if (name !== undefined) fields.name = name.trim();
    if (expiresAtRaw !== undefined) fields.expires_at = parseExpiresAt(expiresAtRaw);
    const result = await updateApiKey(req.cognitoUser!.sub, req.params.id, fields);
    res.json({ data: result });
  }),
);

accountRouter.post(
  "/v1/account/api-keys/:id/revoke",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    await revokeApiKey(req.cognitoUser!.sub, req.params.id);
    res.json({ data: { id: req.params.id, active: false } });
  }),
);

accountRouter.get(
  "/v1/account/me",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const info = await getAccountInfo(req.cognitoUser!.sub);
    res.json({ data: info });
  }),
);

accountRouter.get(
  "/v1/account/usage",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const usage = await getAccountUsage(req.cognitoUser!.sub);
    res.json({ data: usage });
  }),
);

accountRouter.post(
  "/v1/account/checkout",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const { plan, cpfCnpj, name } = (req.body ?? {}) as { plan?: PlanTier; cpfCnpj?: string; name?: string };
    if (!plan || !cpfCnpj || !name) {
      throw new HttpError(400, "plan, cpfCnpj e name sao obrigatorios", "VALIDATION_ERROR");
    }
    const result = await startCheckout(req.cognitoUser!.sub, { plan, cpfCnpj, name });
    res.status(201).json({ data: result });
  }),
);

accountRouter.get(
  "/v1/account/subscription",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const status = await getSubscriptionStatus(req.cognitoUser!.sub);
    res.json({ data: status });
  }),
);

// Uso diario (REST vs MCP) dos ultimos 30 dias, zero-preenchido -- pros graficos do dashboard.
accountRouter.get(
  "/v1/account/usage/daily",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const daily = await getAccountDailyUsage(req.cognitoUser!.sub);
    res.json({ data: daily });
  }),
);

// Secao informativa do dashboard (URL do MCP + lista de ferramentas/descricoes) -- estatico,
// sem logica de negocio. Tools vem de MCP_TOOLS_INFO (src/mcp/mcp.router.ts), fonte unica --
// nao redigita as descricoes aqui.
accountRouter.get(
  "/v1/account/mcp-info",
  cognitoAuthenticate,
  asyncHandler(async (_req, res) => {
    res.json({ data: { mcp_url: `http://localhost:${env.port}/mcp`, tools: MCP_TOOLS_INFO } });
  }),
);
