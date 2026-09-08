/**
 * Dois modos de falha distintos de proposito. Mensagem invalida e' erro de quem chamou: o dado
 * nunca chegou a sair daqui e re-tentar o mesmo payload nao muda nada. Falha de entrega e' do
 * provider e pode ser transitoria (timeout, 5xx). Quem chama decide entre corrigir e re-tentar
 * olhando o tipo do erro, sem parsear a mensagem em portugues -- que pode mudar.
 */

export class EmailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailValidationError";
  }
}

export interface EmailDeliveryErrorDetails {
  status?: number;
  providerCode?: string;
  providerRequestId?: string;
}

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly details: EmailDeliveryErrorDetails = {},
  ) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}
