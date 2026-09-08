import { randomUUID } from "node:crypto";
import { DeleteCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { AlertDeliveryJob, TenderMatchedPayload } from "../common/ports/alert-queue-port";

const TABLE = "WebhookDeliveryQueue";

// Registro persistido: o minimo pra REFAZER a entrega apos um restart. Nao guarda nada do alvo
// (url, secret, destinatario) de proposito -- a recuperacao rele o SavedFilter (chave
// customer_id+filter_id) e remonta o alvo de la, entao nao existe segunda copia durvel de segredo
// nem um alvo que envelhece em silencio se o cliente editar o filtro enquanto a entrega esta
// pendente.
export interface PersistedDeliveryJob {
  delivery_id: string;
  filter_id: string;
  customer_id: string;
  payload: TenderMatchedPayload;
  idempotencyKey: string;
  created_at: string;
}

/**
 * Grava a intencao de entrega ANTES de tentar despachar (item #5 do PLAN.md: fila em memoria
 * perde tudo em restart do processo). Se o processo morrer no meio das tentativas (crash,
 * `docker compose down`, deploy), o item continua na tabela e e' recuperado no proximo boot
 * (ver `recoverPendingAlertDeliveries`). Retorna o delivery_id gerado, usado pra remover o item
 * ao final (sucesso ou esgotamento de tentativas).
 */
export async function persistPendingDelivery(job: AlertDeliveryJob): Promise<string> {
  const deliveryId = randomUUID();
  await ddbDocClient.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        delivery_id: deliveryId,
        filter_id: job.filter_id,
        customer_id: job.customer_id,
        payload: job.payload,
        idempotencyKey: job.idempotencyKey,
        created_at: new Date().toISOString(),
      } satisfies PersistedDeliveryJob,
    }),
  );
  return deliveryId;
}

export async function removePendingDelivery(deliveryId: string): Promise<void> {
  await ddbDocClient.send(new DeleteCommand({ TableName: TABLE, Key: { delivery_id: deliveryId } }));
}

/**
 * So chamada uma vez, no boot (ver `recoverPendingAlertDeliveries`). `Scan` aceitavel aqui por
 * excecao deliberada a regra geral "GSI-first, nunca Scan" do projeto: esta nao e' tabela de
 * dado de cliente em escala (Tenders/SavedFilters), e' uma fila operacional que fica vazia no
 * caminho feliz -- so tem item quando um processo anterior morreu no meio de uma entrega. Uma
 * fila SQS real (Fase 7) troca isso por poll nativo, sem Scan.
 */
export async function listAllPendingDeliveries(): Promise<PersistedDeliveryJob[]> {
  const items: PersistedDeliveryJob[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddbDocClient.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey: lastKey }),
    );
    items.push(...((res.Items ?? []) as PersistedDeliveryJob[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}
