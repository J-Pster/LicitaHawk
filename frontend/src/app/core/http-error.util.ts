/** Extrai a mensagem de `{error:{code,message}}` (formato padrão de erro do backend). */
export function extractErrorMessage(err: unknown, fallback: string): string {
  const httpErr = err as { error?: { error?: { message?: string } } };
  return httpErr?.error?.error?.message || fallback;
}
