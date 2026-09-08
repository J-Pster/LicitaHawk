import { Router } from "express";
import { cognitoAuthenticate } from "../common/auth/cognito-auth.middleware";
import { asyncHandler } from "../common/async-handler";
import { HttpError } from "../common/http-error";
import { SavedSearch } from "./saved-search.types";
import {
  countNewMatchesForSavedSearch,
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearchesForAccount,
  markSavedSearchSeen,
  updateSavedSearch,
} from "./saved-searches.service";

// Router de buscas salvas (Saved Searches) via CONTA -- mesmo padrao de account-webhooks.router.ts:
// autenticado por ID token do Cognito (req.cognitoUser.sub vira account_id), CRUD delegado
// inteiramente a saved-searches.service.ts (nunca duplica logica de validacao/persistencia aqui).
export const savedSearchesRouter = Router();

function toSavedSearchResponse(savedSearch: SavedSearch) {
  return {
    saved_search_id: savedSearch.saved_search_id,
    account_id: savedSearch.account_id,
    name: savedSearch.name,
    criteria: savedSearch.criteria,
    created_at: savedSearch.created_at,
    last_seen_at: savedSearch.last_seen_at,
  };
}

savedSearchesRouter.get(
  "/v1/account/saved-searches",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const savedSearches = await listSavedSearchesForAccount(req.cognitoUser!.sub);
    res.json({ data: savedSearches.map(toSavedSearchResponse) });
  }),
);

savedSearchesRouter.post(
  "/v1/account/saved-searches",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const { name, criteria } = (req.body ?? {}) as { name?: string; criteria?: SavedSearch["criteria"] };
    const savedSearch = await createSavedSearch(req.cognitoUser!.sub, { name: name ?? "", criteria: criteria ?? {} });
    res.status(201).json({ data: toSavedSearchResponse(savedSearch) });
  }),
);

savedSearchesRouter.patch(
  "/v1/account/saved-searches/:id",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const { name, criteria } = (req.body ?? {}) as { name?: string; criteria?: SavedSearch["criteria"] };
    if (name === undefined && criteria === undefined) {
      throw new HttpError(400, "informe ao menos 'name' ou 'criteria' para atualizar", "VALIDATION_ERROR");
    }

    const updated = await updateSavedSearch(req.cognitoUser!.sub, req.params.id, { name, criteria });
    if (!updated) {
      throw new HttpError(404, "saved search nao encontrado", "NOT_FOUND");
    }
    res.json({ data: toSavedSearchResponse(updated) });
  }),
);

savedSearchesRouter.delete(
  "/v1/account/saved-searches/:id",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const deleted = await deleteSavedSearch(req.cognitoUser!.sub, req.params.id);
    if (!deleted) {
      throw new HttpError(404, "saved search nao encontrado", "NOT_FOUND");
    }
    res.status(204).send();
  }),
);

savedSearchesRouter.get(
  "/v1/account/saved-searches/:id/new-count",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const result = await countNewMatchesForSavedSearch(req.cognitoUser!.sub, req.params.id);
    if (!result.found) {
      throw new HttpError(404, "saved search nao encontrado", "NOT_FOUND");
    }
    res.json({ new_count: result.new_count });
  }),
);

savedSearchesRouter.post(
  "/v1/account/saved-searches/:id/mark-seen",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const updated = await markSavedSearchSeen(req.cognitoUser!.sub, req.params.id);
    if (!updated) {
      throw new HttpError(404, "saved search nao encontrado", "NOT_FOUND");
    }
    res.json({ data: toSavedSearchResponse(updated) });
  }),
);
