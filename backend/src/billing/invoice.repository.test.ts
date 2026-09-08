import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { applyStatusUpdateGuarded, createInvoice, getInvoice } from "./invoice.repository";

function conditionalCheckFailed(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({ message: "conditional check failed", $metadata: {} });
}

beforeEach(() => {
  sendMock.mockReset();
});

describe("applyStatusUpdateGuarded -- guarda de estado terminal da NF-e (Fase 5.4)", () => {
  it("aplica a transicao quando o status ainda nao existe (primeira atualizacao real apos criacao)", async () => {
    sendMock.mockResolvedValueOnce({});

    const result = await applyStatusUpdateGuarded("ref-1", "processando_autorizacao", { raw: true });

    expect(result).toEqual({ applied: true });
  });

  it("aplica uma transicao normal entre estados nao-terminais (processando -> autorizado)", async () => {
    sendMock.mockResolvedValueOnce({});

    const result = await applyStatusUpdateGuarded("ref-1", "autorizado", {}, { numero: "123", codigoVerificacao: "abc" });

    expect(result).toEqual({ applied: true });
    const command = sendMock.mock.calls[0][0] as UpdateCommand;
    expect(command.input.ConditionExpression).toContain("#status IN");
  });

  it("REGRESSAO (callback fora de ordem): bloqueia um callback atrasado tentando reverter autorizado -> processando", async () => {
    sendMock.mockRejectedValueOnce(conditionalCheckFailed());

    const result = await applyStatusUpdateGuarded("ref-1", "processando_autorizacao", {});

    expect(result).toEqual({ applied: false });
  });

  it("REGRESSAO (callback fora de ordem): bloqueia callback atrasado tentando reverter cancelado -> autorizado", async () => {
    sendMock.mockRejectedValueOnce(conditionalCheckFailed());

    const result = await applyStatusUpdateGuarded("ref-1", "autorizado", {});

    expect(result).toEqual({ applied: false });
  });

  it("permite a transicao legitima autorizado -> cancelado (cancelamento confirmado depois da autorizacao)", async () => {
    sendMock.mockResolvedValueOnce({});

    // A condicao em si nao sabe qual e' o estado ATUAL no DynamoDB (isso e' avaliado
    // atomicamente pelo proprio servico); aqui confirmamos que a expressao de condicao
    // realmente contempla essa transicao especifica (nao rejeita de saida).
    const result = await applyStatusUpdateGuarded("ref-1", "cancelado", {});

    expect(result).toEqual({ applied: true });
    const command = sendMock.mock.calls[0][0] as UpdateCommand;
    expect(command.input.ConditionExpression).toContain(":autorizado AND :next = :cancelado");
  });

  it("trata um eco idempotente do MESMO status como aplicado (reenvio do mesmo callback do Focus nao e' bloqueado como se fosse reversao)", async () => {
    sendMock.mockResolvedValueOnce({});

    const result = await applyStatusUpdateGuarded("ref-1", "autorizado", {});

    expect(result).toEqual({ applied: true });
  });

  it("bloqueia reversao de cancelado -> autorizado (cancelado tambem e' terminal, nenhuma transicao de volta e' permitida)", async () => {
    sendMock.mockRejectedValueOnce(conditionalCheckFailed());

    const result = await applyStatusUpdateGuarded("ref-1", "autorizado", {});

    expect(result).toEqual({ applied: false });
  });

  it("inclui numero/codigo_verificacao/pdf_url/xml_url no SET so quando fornecidos, e nunca falha por campo ausente", async () => {
    sendMock.mockResolvedValueOnce({});

    await applyStatusUpdateGuarded("ref-1", "autorizado", {}, { numero: "999" });

    const command = sendMock.mock.calls[0][0] as UpdateCommand;
    expect(command.input.UpdateExpression).toContain("numero = :numero");
    expect(command.input.UpdateExpression).not.toContain("codigo_verificacao");
    expect(command.input.UpdateExpression).not.toContain("pdf_url");
  });

  it("remove error_message quando nao fornecido nesta atualizacao (nao deixa mensagem de erro velha grudada apos sucesso)", async () => {
    sendMock.mockResolvedValueOnce({});

    await applyStatusUpdateGuarded("ref-1", "autorizado", {}, { numero: "1" });

    const command = sendMock.mock.calls[0][0] as UpdateCommand;
    expect(command.input.UpdateExpression).toContain("REMOVE error_message");
  });

  it("seta error_message quando fornecido (falha de autorizacao reportada pelo callback)", async () => {
    sendMock.mockResolvedValueOnce({});

    await applyStatusUpdateGuarded("ref-1", "erro_autorizacao", {}, { errorMessage: "CPF invalido" });

    const command = sendMock.mock.calls[0][0] as UpdateCommand;
    expect(command.input.UpdateExpression).toContain("error_message = :err");
    expect(command.input.ExpressionAttributeValues?.[":err"]).toBe("CPF invalido");
  });

  it("propaga erro inesperado do DynamoDB (nao ConditionalCheckFailedException) sem engolir", async () => {
    sendMock.mockRejectedValueOnce(new Error("timeout de rede"));

    await expect(applyStatusUpdateGuarded("ref-1", "autorizado", {})).rejects.toThrow("timeout de rede");
  });
});

describe("createInvoice / getInvoice", () => {
  it("createInvoice grava com ConditionExpression contra colisao de ref", async () => {
    sendMock.mockResolvedValueOnce({});

    await createInvoice({
      ref: "ref-1",
      status: "processando_autorizacao",
      asaas_payment_id: "pay_1",
      asaas_customer_id: "cus_1",
      amount_brl: 149,
      request_payload: {} as never,
    });

    const command = sendMock.mock.calls[0][0];
    expect(command.input.ConditionExpression).toBe("attribute_not_exists(#ref)");
  });

  it("getInvoice retorna undefined quando o item nao existe (nao lanca)", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });

    await expect(getInvoice("ref-inexistente")).resolves.toBeUndefined();
  });
});
