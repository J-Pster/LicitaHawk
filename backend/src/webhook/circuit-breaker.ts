import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { opsAlert } from "../common/ops-alert";

const TABLE = "SavedFilters";
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = Number(
  process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES ?? 5,
);

/**
 * Incrementa o contador de falhas consecutivas do filtro via UpdateItem+ADD (nunca get-then-put --
 * isso e o unico jeito de nao perder incremento sob concorrencia). Se o contador atingir o limite,
 * desativa o filtro.
 */
export async function recordFailure(
  customerId: string,
  filterId: string,
  maxFailures: number = DEFAULT_MAX_CONSECUTIVE_FAILURES,
): Promise<number> {
  try {
    const res = await ddbDocClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { customer_id: customerId, filter_id: filterId },
        UpdateExpression: "ADD consecutive_failures :one SET updated_at = :now",
        // Achado real da revisao de qualidade: sem essa condicao, se o filtro for deletado
        // enquanto um webhook dele ainda esta em retry, UpdateItem RECRIA o item com so
        // customer_id/filter_id/consecutive_failures/updated_at -- um item fantasma sem
        // url/secret/active/uf/modalidade, que quebra quem depois listar filtros do cliente.
        ConditionExpression: "attribute_exists(customer_id)",
        ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    const newCount = Number(res.Attributes?.consecutive_failures ?? 0);
    if (newCount >= maxFailures) {
      await disableFilter(customerId, filterId, newCount);
    }
    return newCount;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      console.warn(`[circuit-breaker] filtro ${filterId} nao existe mais, falha ignorada`);
      return 0;
    }
    throw err;
  }
}

async function disableFilter(customerId: string, filterId: string, failureCount: number): Promise<void> {
  try {
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { customer_id: customerId, filter_id: filterId },
        UpdateExpression: "SET active = :false, updated_at = :now",
        // Condicao evita corrida entre duas falhas concorrentes que ambas cruzam o limite ao mesmo
        // tempo: so a primeira desativa/notifica de verdade, a segunda cai no catch abaixo e nao
        // duplica nada.
        ConditionExpression: "active = :true",
        ExpressionAttributeValues: { ":false": false, ":true": true, ":now": new Date().toISOString() },
      }),
    );
    // TODO Fase 7: trocar por SES real (item #4 do PLAN.md) -- ate la, opsAlert ja da o
    // formato estruturado que um Metric Filter do CloudWatch consegue casar sem mudar o
    // chamador de novo.
    opsAlert("webhook_filter_circuit_breaker_open", "warning", {
      filter_id: filterId,
      customer_id: customerId,
      consecutive_failures: failureCount,
    });
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return;
    }
    throw err;
  }
}

/**
 * Reseta o contador ao sucesso (fecha o circuito). Reset simples (SET, nao condicional) --
 * aceitavel pro MVP: pior caso e um off-by-one no contador sob corrida rara com uma falha
 * concorrente, nao uma falha de seguranca.
 */
export async function recordSuccess(customerId: string, filterId: string): Promise<void> {
  try {
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { customer_id: customerId, filter_id: filterId },
        UpdateExpression: "SET consecutive_failures = :zero, updated_at = :now",
        ConditionExpression: "attribute_exists(customer_id)",
        ExpressionAttributeValues: { ":zero": 0, ":now": new Date().toISOString() },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return;
    throw err;
  }
}

export class FilterNotDisabledError extends Error {
  constructor() {
    super("filtro nao esta desativado por circuit breaker");
    this.name = "FilterNotDisabledError";
  }
}

/**
 * Bug real encontrado nesta rodada: o circuit breaker desativa o filtro (active=false) apos N
 * falhas consecutivas, mas nao existia NENHUM caminho pra reativar -- nem rota HTTP, nem
 * ferramenta MCP. Um cliente que corrigisse o endpoint quebrado ficava com o filtro morto pra
 * sempre, sem alternativa alem de deletar e recriar (perdendo o historico de entregas, ja que
 * WebhookDeliveryLog e' indexado por filter_id). Corrigido com este endpoint de reativacao
 * explicita (exposto em POST /v1/filters/:id/reactivate, webhook.router.ts) -- so aceita
 * reativar um filtro que esta de fato desativado (active=false), zera o contador de falhas pra
 * dar um circuito fechado limpo, e usa ConditionExpression pra nao mascarar corrida com uma
 * falha concorrente que ainda nao terminou de desativar.
 */
export async function reactivateFilter(customerId: string, filterId: string): Promise<void> {
  try {
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { customer_id: customerId, filter_id: filterId },
        UpdateExpression: "SET active = :true, consecutive_failures = :zero, updated_at = :now",
        ConditionExpression: "attribute_exists(customer_id) AND active = :false",
        ExpressionAttributeValues: { ":true": true, ":false": false, ":zero": 0, ":now": new Date().toISOString() },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new FilterNotDisabledError();
    }
    throw err;
  }
}
