import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { AlertChannel } from "./filter.types";
import { DispatchResult } from "./webhook-dispatcher";

const TABLE = "WebhookDeliveryLog";

/**
 * Grava o resultado final da entrega (apos todas as tentativas) em WebhookDeliveryLog
 * (PK=filter_id, SK=timestamp) -- usado pela rota GET /v1/filters/{id}/deliveries da Fase 3.
 *
 * `channel` diz por onde a entrega saiu. Registro antigo nao tem o campo e e', por definicao,
 * webhook (era o unico canal) -- quem le resolve isso na leitura, como em filter.types.ts.
 * Para o canal email nao existe status HTTP, entao `status_code` fica null: inventar um 200
 * faria o feed de entregas mentir sobre o que aconteceu.
 */
export async function writeDeliveryLog(
  filterId: string,
  attempts: number,
  result: DispatchResult,
  channel: AlertChannel,
): Promise<void> {
  await ddbDocClient.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        filter_id: filterId,
        timestamp: new Date().toISOString(),
        channel,
        success: result.success,
        status_code: result.statusCode ?? null,
        error: result.error ?? null,
        attempts,
      },
    }),
  );
}
