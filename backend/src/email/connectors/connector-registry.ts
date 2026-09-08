import { EmailPort } from "../../common/ports/email-port";
import { ConsoleEmailConnector } from "./console.connector";
import { ZeptoMailConnector } from "./zeptomail.connector";

/**
 * Registro nome -> connector. Mapa table-driven de proposito: adicionar SES/Resend/Postmark e'
 * criar o arquivo do connector e por uma linha aqui. Nenhum `switch` espalhado pelo codigo,
 * nenhum chamador tocado (OCP). O tipo EmailProviderName sai do proprio mapa, entao a lista de
 * valores validos nunca desalinha da lista de connectors que existem de verdade.
 */
const CONNECTOR_FACTORIES = {
  zeptomail: () => new ZeptoMailConnector(),
  console: () => new ConsoleEmailConnector(),
} as const satisfies Record<string, () => EmailPort>;

export type EmailProviderName = keyof typeof CONNECTOR_FACTORIES;

export const EMAIL_PROVIDER_NAMES = Object.keys(CONNECTOR_FACTORIES) as EmailProviderName[];

export function createEmailConnector(name: string): EmailPort {
  // Object.hasOwn e nao `if (CONNECTOR_FACTORIES[name])`: indexar um objeto literal com
  // "toString"/"constructor" devolve a funcao herdada de Object.prototype, que passa por um
  // guard truthy e explode depois, longe daqui.
  if (!Object.hasOwn(CONNECTOR_FACTORIES, name)) {
    throw new Error(
      `EMAIL_PROVIDER="${name}" desconhecido. Valores validos: ${EMAIL_PROVIDER_NAMES.join(", ")}.`,
    );
  }
  return CONNECTOR_FACTORIES[name as EmailProviderName]();
}
