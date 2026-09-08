import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "./dynamodb-client";
import { SavedSearch } from "../account/saved-search.types";

export class SavedSearchNotFoundError extends Error {
  constructor() {
    super("saved search not found or not owned by caller");
    this.name = "SavedSearchNotFoundError";
  }
}

/**
 * Mesma protecao IDOR de common/filter-ownership.ts::assertFilterOwnership, adaptada pra
 * SavedSearches (chave composta account_id HASH + saved_search_id RANGE): um GetItem com as duas
 * chaves so acha o item se ele pertencer mesmo ao account_id informado -- se o saved_search_id
 * existir mas for de outra conta, o resultado e sempre "nao encontrado" (nunca "existe mas nao e
 * seu"), pra nao vazar a existencia de recursos alheios.
 */
export async function assertSavedSearchOwnership(accountId: string, savedSearchId: string): Promise<SavedSearch> {
  const res = await ddbDocClient.send(
    new GetCommand({
      TableName: "SavedSearches",
      Key: { account_id: accountId, saved_search_id: savedSearchId },
    }),
  );
  if (!res.Item) {
    throw new SavedSearchNotFoundError();
  }
  return res.Item as SavedSearch;
}
