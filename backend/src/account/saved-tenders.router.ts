import { Router } from "express";
import { cognitoAuthenticate } from "../common/auth/cognito-auth.middleware";
import { asyncHandler } from "../common/async-handler";
import { HttpError } from "../common/http-error";
import { SavedTender } from "./saved-tender.types";
import {
  deleteSavedTender,
  isSavedTender,
  listSavedTendersForAccount,
  saveTender,
  updateSavedTenderNote,
} from "./saved-tenders.service";

// Router de licitacoes salvas (SavedTenders) via CONTA -- mesmo padrao de saved-searches.router.ts:
// autenticado por ID token do Cognito (req.cognitoUser.sub vira account_id), CRUD delegado
// inteiramente a saved-tenders.service.ts (nunca duplica logica de validacao/persistencia aqui).
//
// `:id` e' o pncp_control_number, que contem barra literal (ex.: "...-1-000134/2026"). O cliente
// url-encoda (encodeURIComponent) e o Express entrega ja decodificado em req.params.id, mesmo
// com sufixo depois (ex.: "/status") -- e o mesmo comportamento que GET /v1/tenders/:id ja usa,
// sem tratamento especial nenhum: a barra codificada (%2F) nunca vira delimitador de segmento.
export const savedTendersRouter = Router();

function toSavedTenderResponse(savedTender: SavedTender) {
  return {
    account_id: savedTender.account_id,
    pncp_control_number: savedTender.pncp_control_number,
    note: savedTender.note,
    created_at: savedTender.created_at,
    snapshot: savedTender.snapshot,
  };
}

savedTendersRouter.get(
  "/v1/account/saved-tenders",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const savedTenders = await listSavedTendersForAccount(req.cognitoUser!.sub);
    res.json({ data: savedTenders.map(toSavedTenderResponse) });
  }),
);

savedTendersRouter.post(
  "/v1/account/saved-tenders",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const { pncp_control_number, note } = (req.body ?? {}) as {
      pncp_control_number?: string;
      note?: string;
    };
    const savedTender = await saveTender(req.cognitoUser!.sub, {
      pncp_control_number: pncp_control_number ?? "",
      note,
    });
    res.status(201).json({ data: toSavedTenderResponse(savedTender) });
  }),
);

savedTendersRouter.patch(
  "/v1/account/saved-tenders/:id",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const { note } = (req.body ?? {}) as { note?: string | null };
    if (note === undefined) {
      throw new HttpError(400, "'note' e obrigatorio", "VALIDATION_ERROR");
    }
    const updated = await updateSavedTenderNote(req.cognitoUser!.sub, req.params.id, note);
    if (!updated) {
      throw new HttpError(404, "licitacao salva nao encontrada", "NOT_FOUND");
    }
    res.json({ data: toSavedTenderResponse(updated) });
  }),
);

savedTendersRouter.delete(
  "/v1/account/saved-tenders/:id",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const deleted = await deleteSavedTender(req.cognitoUser!.sub, req.params.id);
    if (!deleted) {
      throw new HttpError(404, "licitacao salva nao encontrada", "NOT_FOUND");
    }
    res.status(204).send();
  }),
);

savedTendersRouter.get(
  "/v1/account/saved-tenders/:id/status",
  cognitoAuthenticate,
  asyncHandler(async (req, res) => {
    const saved = await isSavedTender(req.cognitoUser!.sub, req.params.id);
    res.json({ data: { saved } });
  }),
);
