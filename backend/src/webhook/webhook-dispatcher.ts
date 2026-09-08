import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { resolveAndAssertSafe } from "./ssrf-guard";
import { signPayload } from "./hmac";

export interface DispatchResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

const TIMEOUT_MS = 5000;

/**
 * Camada de rede pura: monta e envia o POST assinado direto no IP informado (ja validado por quem
 * chama). Separada de dispatchWebhook por responsabilidade unica -- permite testar a assinatura
 * HMAC/headers/entrega HTTP de verdade contra um listener local sem depender do gate de SSRF (que
 * bloquearia qualquer IP local por definicao, ja que loopback/privado sao sempre bloqueados). O
 * caminho de producao (dispatchWebhook, unico ponto usado pela fila real) sempre passa pelo gate
 * primeiro -- esta funcao nunca e chamada com um IP nao validado fora de teste.
 */
export async function sendSignedRequest(
  ip: string,
  url: string,
  secret: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<DispatchResult> {
  const parsed = new URL(url);
  const body = JSON.stringify(payload);
  const signature = signPayload(secret, body);
  const isHttps = parsed.protocol === "https:";
  const transport = isHttps ? https : http;

  const options: https.RequestOptions = {
    hostname: ip,
    port: parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
    path: `${parsed.pathname}${parsed.search}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Host: parsed.hostname,
      "X-LicitaHawk-Signature": `sha256=${signature}`,
      "Idempotency-Key": idempotencyKey,
    },
    timeout: TIMEOUT_MS,
    // SNI + validacao de certificado contra o hostname original, mesmo conectando pelo IP.
    ...(isHttps ? { servername: parsed.hostname } : {}),
  };

  return new Promise((resolve) => {
    const req = transport.request(options, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        resolve({ success: false, statusCode: status, error: `redirect nao seguido (status ${status})` });
        return;
      }
      resolve({ success: status >= 200 && status < 300, statusCode: status });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
    req.write(body);
    req.end();
  });
}

/**
 * Ponto unico usado pela fila real (Fase 4.2): resolve e valida o IP a cada chamada (nunca
 * cacheado) e so entao envia a requisicao -- as duas mitigacoes de DNS rebinding exigidas pelo
 * plano (revalidar a cada disparo + nao seguir redirect, este ultimo dentro de sendSignedRequest).
 * Lanca SsrfBlockedError (nao capturada aqui, de proposito) se a URL resolver pra um IP bloqueado.
 */
export async function dispatchWebhook(
  url: string,
  secret: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<DispatchResult> {
  const safe = await resolveAndAssertSafe(url);
  return sendSignedRequest(safe.ip, url, secret, payload, idempotencyKey);
}
