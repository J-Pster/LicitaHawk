import { createHmac, randomBytes } from "node:crypto";

/**
 * Segredo por filtro, CSPRNG (crypto.randomBytes) -- nunca logado, nem em mensagem de erro.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function signPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}
