import { AlertDeliveryTarget } from "../common/ports/alert-queue-port";
import { SavedFilter } from "./filter.types";

/**
 * Traduz o canal do filtro no alvo de entrega do job. Um lugar so: matcher, disparo de teste e
 * recuperacao pos-restart montam o alvo pelo mesmo caminho, entao um canal novo (SMS, Telegram)
 * nao pode ser esquecido em um dos tres. O `switch` exaustivo sobre a uniao faz o compilador
 * cobrar o canal novo aqui.
 */
export function toDeliveryTarget(filter: SavedFilter): AlertDeliveryTarget {
  switch (filter.channel) {
    case "webhook":
      return { channel: "webhook", url: filter.webhook_url, secret: filter.webhook_secret };
    case "email":
      return { channel: "email" };
  }
}
