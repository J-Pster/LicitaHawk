import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { InvoiceStatus } from "./focus-client";
import { NfsePayload } from "./nfse-payload";

const INVOICES_TABLE = "Invoices";

export interface InvoiceRecord {
  ref: string;
  status: InvoiceStatus;
  asaas_payment_id: string;
  asaas_customer_id: string;
  asaas_subscription_id?: string;
  plan_tier?: string;
  amount_brl: number;
  request_payload: NfsePayload;
  created_at: string;
  updated_at: string;
  numero?: string;
  codigo_verificacao?: string;
  pdf_url?: string;
  xml_url?: string;
  error_message?: string;
  focus_response?: unknown;
}

export async function createInvoice(
  item: Omit<InvoiceRecord, "created_at" | "updated_at">,
): Promise<void> {
  const now = new Date().toISOString();
  await ddbDocClient.send(
    new PutCommand({
      TableName: INVOICES_TABLE,
      Item: { ...item, created_at: now, updated_at: now },
      // ref e sempre gerado com um sufixo aleatorio (ver invoice-emitter), entao colisao
      // seria sinal de bug -- a condicao so existe como segunda linha de defesa.
      ConditionExpression: "attribute_not_exists(#ref)",
      ExpressionAttributeNames: { "#ref": "ref" },
    }),
  );
}

export async function getInvoice(ref: string): Promise<InvoiceRecord | undefined> {
  const res = await ddbDocClient.send(
    new GetCommand({ TableName: INVOICES_TABLE, Key: { ref } }),
  );
  return res.Item as InvoiceRecord | undefined;
}

export interface FocusArtifacts {
  numero?: string;
  codigoVerificacao?: string;
  pdfUrl?: string;
  xmlUrl?: string;
  errorMessage?: string;
}

/**
 * UpdateItem condicional que reimplementa a guarda de estado terminal do
 * pster-finance (NfseService.handleCallback / isTerminalStatus): uma vez que a
 * nota chega em `autorizado` ou `cancelado`, nenhum callback atrasado pode
 * reverter isso -- exceto autorizado -> cancelado (cancelamento confirmado
 * depois). Condicao avaliada atomicamente no proprio UpdateItem (nunca
 * get-then-put), entao dois callbacks fora de ordem concorrentes nao tem
 * race condition entre eles.
 */
export async function applyStatusUpdateGuarded(
  ref: string,
  nextStatus: InvoiceStatus,
  focusResponse: unknown,
  artifacts: FocusArtifacts = {},
): Promise<{ applied: boolean }> {
  const setParts = ["#status = :next", "updated_at = :now", "focus_response = :focusResponse"];
  const removeParts: string[] = [];
  const values: Record<string, unknown> = {
    ":next": nextStatus,
    ":now": new Date().toISOString(),
    ":focusResponse": focusResponse,
    ":autorizado": "autorizado",
    ":cancelado": "cancelado",
  };

  if (artifacts.numero !== undefined) {
    setParts.push("numero = :numero");
    values[":numero"] = artifacts.numero;
  }
  if (artifacts.codigoVerificacao !== undefined) {
    setParts.push("codigo_verificacao = :cv");
    values[":cv"] = artifacts.codigoVerificacao;
  }
  if (artifacts.pdfUrl !== undefined) {
    setParts.push("pdf_url = :pdf");
    values[":pdf"] = artifacts.pdfUrl;
  }
  if (artifacts.xmlUrl !== undefined) {
    setParts.push("xml_url = :xml");
    values[":xml"] = artifacts.xmlUrl;
  }
  if (artifacts.errorMessage !== undefined) {
    setParts.push("error_message = :err");
    values[":err"] = artifacts.errorMessage;
  } else {
    removeParts.push("error_message");
  }

  let updateExpression = `SET ${setParts.join(", ")}`;
  if (removeParts.length > 0) {
    updateExpression += ` REMOVE ${removeParts.join(", ")}`;
  }

  try {
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: INVOICES_TABLE,
        Key: { ref },
        UpdateExpression: updateExpression,
        // Permite a transicao se: status ainda nao existe (nao deveria acontecer, mas
        // nao trava caso aconteca) OU status atual nao e terminal OU e a transicao
        // legitima autorizado->cancelado OU e um eco idempotente do mesmo status.
        ConditionExpression:
          "attribute_not_exists(#status) OR (NOT (#status IN (:autorizado, :cancelado))) OR (#status = :autorizado AND :next = :cancelado) OR #status = :next",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: values,
      }),
    );
    return { applied: true };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return { applied: false };
    }
    throw err;
  }
}
