// Erro com status HTTP explicito -- o middleware global de erro (src/server.ts) usa isso pra
// decidir 4xx (erro esperado, ex.: input invalido do cliente) vs 500 (erro inesperado, nao
// vaza detalhe interno pro cliente). `code` e' um identificador estavel e legivel por maquina
// (ex.: "VALIDATION_ERROR", "NOT_FOUND") -- consumidores da API podem fazer switch nele sem
// parsear a mensagem em portugues, que pode mudar.
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = "ERROR",
  ) {
    super(message);
    this.name = "HttpError";
  }
}
