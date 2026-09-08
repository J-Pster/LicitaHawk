import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { HttpError } from "../common/http-error";
import { getTenderById } from "../tenders/tenders.service";
import { Tender } from "../tenders/tender.types";
import { SavedTender, SavedTenderSnapshot } from "./saved-tender.types";

const SAVED_TENDERS_TABLE = "SavedTenders";

// Mesmo teto de saved-searches.service.ts::validateName em espirito, mas pra um campo de texto
// livre (nota pessoal, nao nome curto): grande o bastante pra um lembrete real, pequeno o
// bastante pra nao virar um documento dentro do item do DynamoDB.
const MAX_NOTE_LENGTH = 500;

function validateControlNumber(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "'pncp_control_number' e obrigatorio", "VALIDATION_ERROR");
  }
  return value.trim();
}

function validateNote(note: unknown): string | null {
  if (note === null || note === undefined) return null;
  if (typeof note !== "string") {
    throw new HttpError(400, "'note' deve ser string", "VALIDATION_ERROR");
  }
  const trimmed = note.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new HttpError(400, `'note' aceita no maximo ${MAX_NOTE_LENGTH} caracteres`, "VALIDATION_ERROR");
  }
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * O snapshot vem SEMPRE do tender indexado (getTenderById), nunca do que o cliente mandar no
 * corpo da requisicao -- e assim que a lista de licitacoes salvas nao vira um lugar onde alguem
 * grava objeto/valor/orgao arbitrarios so porque controla o payload do POST.
 */
function buildSnapshot(tender: Tender): SavedTenderSnapshot {
  const rawPayload = (tender.raw_payload ?? {}) as Record<string, unknown>;
  const encerramento = rawPayload["dataEncerramentoProposta"];
  return {
    objeto: tender.objeto,
    org_name: tender.org_name,
    uf: tender.uf,
    municipio: tender.municipio,
    modalidade: tender.modalidade,
    valor_estimado: tender.valor_estimado,
    data_publicacao: tender.data_publicacao,
    situacao: tender.situacao,
    data_encerramento_proposta: typeof encerramento === "string" && encerramento ? encerramento : null,
  };
}

/**
 * GetItem direto pela chave composta (account_id + pncp_control_number) -- mesma protecao IDOR
 * de common/saved-search-ownership.ts::assertSavedSearchOwnership: um item que exista mas seja
 * de outra conta nunca aparece aqui, entao "existe mas nao e seu" e "nao existe" respondem igual.
 * Fica local a este arquivo (nao em common/) porque, diferente de SavedSearches, nenhum outro
 * modulo precisa checar posse de uma licitacao salva.
 */
async function getSavedTenderItem(accountId: string, controlNumber: string): Promise<SavedTender | undefined> {
  const res = await ddbDocClient.send(
    new GetCommand({
      TableName: SAVED_TENDERS_TABLE,
      Key: { account_id: accountId, pncp_control_number: controlNumber },
    }),
  );
  return res.Item as SavedTender | undefined;
}

export interface SaveTenderInput {
  pncp_control_number: string;
  note?: string;
}

/**
 * Idempotente pela chave composta: salvar de novo a mesma licitacao nunca duplica, so atualiza.
 * Se `note` vier no corpo, substitui a nota existente; se nao vier (re-salvar sem mexer na nota),
 * preserva a nota que ja existia. O snapshot e sempre reconstruido a partir do tender atual, pra
 * "salvar de novo" tambem servir como forma barata de atualizar o retrato exibido na lista.
 */
export async function saveTender(accountId: string, input: SaveTenderInput): Promise<SavedTender> {
  const controlNumber = validateControlNumber(input.pncp_control_number);
  const noteProvided = input.note !== undefined;
  const validatedNote = noteProvided ? validateNote(input.note) : undefined;

  const tender = await getTenderById(controlNumber);
  if (!tender) {
    throw new HttpError(404, "licitacao nao encontrada", "NOT_FOUND");
  }

  const existing = await getSavedTenderItem(accountId, controlNumber);

  const item: SavedTender = {
    account_id: accountId,
    pncp_control_number: controlNumber,
    note: noteProvided ? (validatedNote as string | null) : (existing?.note ?? null),
    created_at: existing?.created_at ?? new Date().toISOString(),
    snapshot: buildSnapshot(tender),
  };

  await ddbDocClient.send(new PutCommand({ TableName: SAVED_TENDERS_TABLE, Item: item }));
  return item;
}

/**
 * Query por account_id (PK) -- nunca Scan; so lista as licitacoes salvas do proprio dono por
 * construcao. A tabela nao tem GSI por created_at (nenhum outro acesso precisa dele, e o
 * volume por conta e' de favoritos pessoais, nao de resultado de busca), entao "mais recentes
 * primeiro" e' ordenacao em memoria sobre o resultado da Query, nao um segundo indice.
 */
export async function listSavedTendersForAccount(accountId: string): Promise<SavedTender[]> {
  const res = await ddbDocClient.send(
    new QueryCommand({
      TableName: SAVED_TENDERS_TABLE,
      KeyConditionExpression: "account_id = :aid",
      ExpressionAttributeValues: { ":aid": accountId },
    }),
  );
  const items = (res.Items ?? []) as SavedTender[];
  return items.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function updateSavedTenderNote(
  accountId: string,
  controlNumber: string,
  note: string | null,
): Promise<SavedTender | undefined> {
  const existing = await getSavedTenderItem(accountId, controlNumber);
  if (!existing) return undefined;

  const validatedNote = validateNote(note);
  const res = await ddbDocClient.send(
    new UpdateCommand({
      TableName: SAVED_TENDERS_TABLE,
      Key: { account_id: accountId, pncp_control_number: controlNumber },
      UpdateExpression: "SET note = :note",
      ExpressionAttributeValues: { ":note": validatedNote },
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes as SavedTender;
}

export async function deleteSavedTender(accountId: string, controlNumber: string): Promise<boolean> {
  const existing = await getSavedTenderItem(accountId, controlNumber);
  if (!existing) return false;
  await ddbDocClient.send(
    new DeleteCommand({
      TableName: SAVED_TENDERS_TABLE,
      Key: { account_id: accountId, pncp_control_number: controlNumber },
    }),
  );
  return true;
}

export async function isSavedTender(accountId: string, controlNumber: string): Promise<boolean> {
  const existing = await getSavedTenderItem(accountId, controlNumber);
  return existing !== undefined;
}
