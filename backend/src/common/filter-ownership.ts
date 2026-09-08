import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "./dynamodb-client";
import { parseSavedFilter, SavedFilter } from "../webhook/filter.types";

export class FilterNotFoundError extends Error {
  constructor() {
    super("filter not found or not owned by caller");
    this.name = "FilterNotFoundError";
  }
}

/**
 * Protecao IDOR reutilizavel: busca um SavedFilter garantindo que pertence ao customer_id
 * informado. SavedFilters tem chave composta (customer_id HASH + filter_id RANGE), entao um
 * GetItem com as duas chaves so acha o item se ele pertencer mesmo ao customer_id informado --
 * se o filter_id existir mas for de outro cliente, o resultado e sempre "nao encontrado" (nunca
 * "existe mas nao e seu"), pra nao vazar a existencia de recursos alheios.
 *
 * Usada pelo endpoint de teste de webhook (Fase 4.4). As rotas de filtro da Fase 3 (GET/DELETE
 * /v1/filters/{id}, /v1/filters/{id}/deliveries) precisam da mesma checagem -- reusem esta funcao
 * em vez de duplicar a logica.
 */
export async function assertFilterOwnership(customerId: string, filterId: string): Promise<SavedFilter> {
  const res = await ddbDocClient.send(
    new GetCommand({
      TableName: "SavedFilters",
      Key: { customer_id: customerId, filter_id: filterId },
    }),
  );
  if (!res.Item) {
    throw new FilterNotFoundError();
  }
  return parseSavedFilter(res.Item as Record<string, unknown>);
}
