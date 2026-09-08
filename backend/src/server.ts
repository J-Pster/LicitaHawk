import { readFileSync } from "fs";
import { join } from "path";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { load as loadYaml } from "js-yaml";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { env } from "./config/env";
import { startScheduler } from "./scheduler";
import { tendersRouter } from "./tenders/tenders.router";
import { rateLimitRouter } from "./tenders/rate-limit.router";
import { filtersRouter } from "./filters/filters.router";
import { webhookRouter } from "./webhook/webhook.router";
import { billingRouter } from "./billing/billing.router";
import { mcpRouter } from "./mcp/mcp.router";
import { accountRouter } from "./account/account.router";
import { accountWebhooksRouter } from "./account/account-webhooks.router";
import { accountAlertsRouter } from "./account/account-alerts.router";
import { accountPlaygroundRouter } from "./account/account-playground.router";
import { savedSearchesRouter } from "./account/saved-searches.router";
import { savedTendersRouter } from "./account/saved-tenders.router";
import { HttpError } from "./common/http-error";
import { asyncHandler } from "./common/async-handler";
import { ddbDocClient } from "./common/dynamodb-client";
import { recoverPendingWebhookDeliveries } from "./webhook/webhook-queue-recovery";

const app = express();
// CORS: o frontend Angular (dev: localhost:4200) chama esta API a partir de outra origem --
// sem isso, toda chamada do browser (fetch/XHR) e' bloqueada antes mesmo de chegar aqui.
// FRONTEND_ORIGIN vem de env (default localhost:4200) pra nao ficar hardcoded pra sempre; em
// producao (Fase 7) sera o dominio real do frontend.
app.use(cors({ origin: env.frontendOrigin }));
app.use(express.json());

const processStartedAt = Date.now();

// __dirname aponta pra dist/ no build compilado e pra src/ em dev (tsx) -- package.json esta
// sempre um nivel acima de ambos, na raiz do projeto. Lido uma vez no boot (nao por request).
let appVersion = "unknown";
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version?: string };
  appVersion = pkg.version ?? "unknown";
} catch {
  // nao bloqueia o boot por causa de um detalhe de versao no /health.
}

// /health enriquecido (achado da rodada: antes so confirmava que o processo Express estava de
// pe, sem checar a dependencia real -- DynamoDB -- nem expor nada util pra monitoramento
// operacional). GetCommand contra ApiKeys com uma chave inexistente e' barato e nao tem efeito
// colateral (so confirma que a tabela existe e responde); um Item ausente na resposta e' o
// resultado esperado e normal, nao um erro.
app.get(
  "/health",
  asyncHandler(async (_req, res) => {
    let dynamodbStatus: "ok" | "error" = "ok";
    try {
      await ddbDocClient.send(new GetCommand({ TableName: "ApiKeys", Key: { api_key_hash: "healthcheck" } }));
    } catch (err) {
      dynamodbStatus = "error";
      console.error("[health] falha ao checar DynamoDB", err);
    }

    const healthy = dynamodbStatus === "ok";
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      env: env.nodeEnv,
      version: appVersion,
      node_version: process.version,
      uptime_seconds: Math.floor((Date.now() - processStartedAt) / 1000),
      timestamp: new Date().toISOString(),
      dependencies: { dynamodb: dynamodbStatus },
    });
  }),
);

// Swagger UI (/docs): serve docs/openapi.yaml, que ja e a fonte de verdade da API (mantido
// sincronizado desde a Rodada 5 -- ver PLAN.md). Sem autenticacao, so documentacao/testagem
// manual local; o Authorize (cadeado) no topo da UI aceita a mesma API key usada via curl.
try {
  const openapiPath = join(__dirname, "..", "docs", "openapi.yaml");
  const openapiSpec = loadYaml(readFileSync(openapiPath, "utf8")) as Record<string, unknown>;
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));
} catch (err) {
  console.error("[server] falha ao carregar docs/openapi.yaml para o Swagger UI", err);
}

// Integracao final (team-lead): cada router aplica seu proprio middleware de auth POR ROTA
// (nunca via router.use() sem path -- ver comentario em tenders.router.ts/filters.router.ts
// sobre o bug de autenticacao/cobranca em duplicidade que isso causaria aqui, com varios
// routers montados juntos na raiz do app). asaas/focus webhook routers (dentro de billingRouter)
// usam seu proprio token estatico fail-closed, nao a autenticacao por API key.
app.use(tendersRouter);
app.use(rateLimitRouter);
app.use(filtersRouter);
app.use(webhookRouter);
app.use(billingRouter);
app.use(mcpRouter);
app.use(accountRouter);
app.use(accountWebhooksRouter);
app.use(accountAlertsRouter);
app.use(accountPlaygroundRouter);
app.use(savedSearchesRouter);
app.use(savedTendersRouter);

// Middleware global de erro (rede de seguranca final) -- achado real da revisao de qualidade:
// Express 4 nao captura rejeicao de Promise em handler async sozinho; sem isso, um erro nao
// tratado em qualquer rota derrubava o processo Node inteiro (DoS, tirava TODOS os clientes do
// ar, nao so a requisicao que falhou). Toda rota agora usa asyncHandler (src/common/async-handler.ts),
// que encaminha o erro pra ca em vez de deixar a rejeicao escapar sem tratamento.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  console.error("[server] erro nao tratado", err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
});

app.listen(env.port, () => {
  console.log(`[server] licitahawk ouvindo na porta ${env.port} (${env.nodeEnv})`);
  startScheduler();
  // Fire-and-forget de proposito: nao atrasa o servidor aceitar trafego novo por causa de
  // entregas pendentes de um processo anterior (ver webhook-queue-recovery.ts).
  recoverPendingWebhookDeliveries().catch((err) =>
    console.error("[server] falha ao recuperar fila de webhook pendente", err),
  );
});
