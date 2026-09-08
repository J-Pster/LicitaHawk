import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

// Import depois dos mocks (hoisted pelo vitest).
import {
  deleteSavedTender,
  isSavedTender,
  listSavedTendersForAccount,
  saveTender,
  updateSavedTenderNote,
} from "./saved-tenders.service";
import { SavedTender } from "./saved-tender.types";
import { Tender } from "../tenders/tender.types";
import { HttpError } from "../common/http-error";

function buildTender(overrides: Partial<Tender> = {}): Tender {
  return {
    pncp_control_number: "07533656000119-1-000134/2026",
    org_cnpj: "07533656000119",
    org_name: "Prefeitura Teste",
    uf: "GO",
    municipio: "Goiania",
    modalidade: "Pregão - Eletrônico",
    uf_modalidade: "GO#Pregão - Eletrônico",
    objeto: "aquisicao de merenda escolar",
    valor_estimado: 50000,
    data_publicacao: "2026-08-10T00:00:00.000Z",
    data_atualizacao: "2026-08-10T00:00:00.000Z",
    situacao: "divulgada",
    link_pncp: "https://pncp.gov.br/x",
    keywords_tokenized: [],
    raw_payload: { dataEncerramentoProposta: "2026-09-20T18:00:00" },
    ...overrides,
  };
}

function buildSavedTender(overrides: Partial<SavedTender> = {}): SavedTender {
  return {
    account_id: "acc-1",
    pncp_control_number: "07533656000119-1-000134/2026",
    note: null,
    created_at: "2026-08-11T00:00:00.000Z",
    snapshot: {
      objeto: "aquisicao de merenda escolar",
      org_name: "Prefeitura Teste",
      uf: "GO",
      municipio: "Goiania",
      modalidade: "Pregão - Eletrônico",
      valor_estimado: 50000,
      data_publicacao: "2026-08-10T00:00:00.000Z",
      situacao: "divulgada",
      data_encerramento_proposta: "2026-09-20T18:00:00",
    },
    ...overrides,
  };
}

beforeEach(() => {
  sendMock.mockReset();
});

describe("saveTender", () => {
  it("cria uma licitacao salva nova, com snapshot montado a partir do tender indexado", async () => {
    const tender = buildTender();
    sendMock.mockResolvedValueOnce({ Item: tender }); // getTenderById -> GetCommand
    sendMock.mockResolvedValueOnce({ Item: undefined }); // getSavedTenderItem (nao existe ainda)
    sendMock.mockResolvedValueOnce({}); // PutCommand

    const result = await saveTender("acc-1", {
      pncp_control_number: tender.pncp_control_number,
      note: "acompanhar prazo",
    });

    expect(result.account_id).toBe("acc-1");
    expect(result.pncp_control_number).toBe(tender.pncp_control_number);
    expect(result.note).toBe("acompanhar prazo");
    expect(result.snapshot.objeto).toBe(tender.objeto);
    expect(result.snapshot.data_encerramento_proposta).toBe("2026-09-20T18:00:00");

    const putCall = sendMock.mock.calls[2][0];
    expect(putCall).toBeInstanceOf(PutCommand);
    expect(putCall.input.Item.note).toBe("acompanhar prazo");
  });

  it("salvar de novo a mesma licitacao atualiza a nota em vez de duplicar, preservando created_at", async () => {
    const tender = buildTender();
    const existing = buildSavedTender({ note: "nota antiga" });
    sendMock.mockResolvedValueOnce({ Item: tender }); // getTenderById
    sendMock.mockResolvedValueOnce({ Item: existing }); // getSavedTenderItem
    sendMock.mockResolvedValueOnce({}); // PutCommand

    const result = await saveTender("acc-1", {
      pncp_control_number: tender.pncp_control_number,
      note: "nota nova",
    });

    expect(result.created_at).toBe(existing.created_at);
    expect(result.note).toBe("nota nova");

    const putCall = sendMock.mock.calls[2][0];
    expect(putCall.input.Item.created_at).toBe(existing.created_at);
  });

  it("re-salvar sem informar 'note' preserva a nota que ja existia", async () => {
    const tender = buildTender();
    const existing = buildSavedTender({ note: "nota preservada" });
    sendMock.mockResolvedValueOnce({ Item: tender });
    sendMock.mockResolvedValueOnce({ Item: existing });
    sendMock.mockResolvedValueOnce({});

    const result = await saveTender("acc-1", { pncp_control_number: tender.pncp_control_number });

    expect(result.note).toBe("nota preservada");
  });

  it("licitacao inexistente na tabela Tenders retorna 404", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined }); // getTenderById -> nada encontrado

    await expect(
      saveTender("acc-1", { pncp_control_number: "inexistente-1" }),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" } satisfies Partial<HttpError>);

    // So a busca do tender: nunca chega a checar/gravar o item salvo.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("nota acima do limite de 500 caracteres retorna 400", async () => {
    const tender = buildTender();
    sendMock.mockResolvedValueOnce({ Item: tender });

    await expect(
      saveTender("acc-1", {
        pncp_control_number: tender.pncp_control_number,
        note: "a".repeat(501),
      }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" } satisfies Partial<HttpError>);
  });
});

describe("listSavedTendersForAccount", () => {
  it("lista via Query por account_id, mais recentes primeiro", async () => {
    const mais_antigo = buildSavedTender({
      pncp_control_number: "1",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const mais_novo = buildSavedTender({
      pncp_control_number: "2",
      created_at: "2026-06-01T00:00:00.000Z",
    });
    sendMock.mockResolvedValueOnce({ Items: [mais_antigo, mais_novo] });

    const result = await listSavedTendersForAccount("acc-1");

    expect(result.map((r) => r.pncp_control_number)).toEqual(["2", "1"]);
    const queryCall = sendMock.mock.calls[0][0];
    expect(queryCall).toBeInstanceOf(QueryCommand);
    expect(queryCall.input.ExpressionAttributeValues).toEqual({ ":aid": "acc-1" });
  });
});

describe("updateSavedTenderNote", () => {
  it("atualiza so a nota de uma licitacao salva existente", async () => {
    const existing = buildSavedTender();
    sendMock.mockResolvedValueOnce({ Item: existing }); // getSavedTenderItem (ownership)
    sendMock.mockResolvedValueOnce({ Attributes: { ...existing, note: "nota editada" } });

    const result = await updateSavedTenderNote("acc-1", existing.pncp_control_number, "nota editada");

    expect(result?.note).toBe("nota editada");
    const updateCall = sendMock.mock.calls[1][0];
    expect(updateCall).toBeInstanceOf(UpdateCommand);
  });

  it("retorna undefined (404 no router) quando a licitacao nao esta salva", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });

    const result = await updateSavedTenderNote("acc-1", "nao-salva", "nota");

    expect(result).toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("deleteSavedTender", () => {
  it("exclui uma licitacao salva existente", async () => {
    const existing = buildSavedTender();
    sendMock.mockResolvedValueOnce({ Item: existing });
    sendMock.mockResolvedValueOnce({});

    const result = await deleteSavedTender("acc-1", existing.pncp_control_number);

    expect(result).toBe(true);
    const deleteCall = sendMock.mock.calls[1][0];
    expect(deleteCall).toBeInstanceOf(DeleteCommand);
  });

  it("retorna false quando a licitacao nao esta salva", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });

    const result = await deleteSavedTender("acc-1", "nao-salva");

    expect(result).toBe(false);
  });
});

describe("isSavedTender", () => {
  it("retorna true quando o item existe para a conta", async () => {
    sendMock.mockResolvedValueOnce({ Item: buildSavedTender() });

    const result = await isSavedTender("acc-1", "07533656000119-1-000134/2026");

    expect(result).toBe(true);
    const getCall = sendMock.mock.calls[0][0];
    expect(getCall).toBeInstanceOf(GetCommand);
  });

  it("retorna false quando o item nao existe", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });

    const result = await isSavedTender("acc-1", "nao-salva");

    expect(result).toBe(false);
  });
});
