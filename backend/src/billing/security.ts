import { timingSafeEqual } from "node:crypto";

/** Comparacao em tempo constante. Compara tamanho primeiro (sem vazar tempo do conteudo). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Fail-closed: se o segredo esperado nao estiver configurado, SEMPRE rejeita --
 * mesmo em desenvolvimento. Diferente do padrao do pster-finance (que tem bypass
 * em dev quando o token nao esta setado); aqui a exigencia do time foi
 * "fail-closed" sem excecao, entao nao replicamos o bypass.
 */
export function isAuthorized(
  received: string | undefined,
  expected: string | undefined,
  context: string,
): boolean {
  if (!expected) {
    console.error(`[security] ${context}: segredo nao configurado no ambiente -- rejeitando (fail-closed)`);
    return false;
  }
  if (!received) {
    return false;
  }
  return timingSafeEqualStr(received, expected);
}
