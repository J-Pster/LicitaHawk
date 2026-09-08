import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenderMatchedPayload } from "../common/ports/alert-queue-port";

const findAccountMock = vi.fn();
vi.mock("../account/account.repository", () => ({
  findAccountByCustomerId: (...args: unknown[]) => findAccountMock(...args),
}));

const sendMock = vi.fn();
vi.mock("../email/email.instance", () => ({
  emailService: { send: (...args: unknown[]) => sendMock(...args) },
}));

// Import depois dos mocks (hoisted pelo vitest).
import { dispatchAlertEmail } from "./email-alert-dispatcher";
import { EmailDeliveryError, EmailValidationError } from "../email/email.errors";

const payload: TenderMatchedPayload = {
  event: "tender.matched",
  filter_id: "filter-1",
  tender: {
    pncp_control_number: "12345/2026",
    org_cnpj: "12345678000199",
    org_name: "Prefeitura de Goiania",
    uf: "GO",
    modalidade: "Pregão - Eletrônico",
    objeto: "Aquisicao de merenda escolar",
    valor_estimado: 1000,
    link_pncp: "https://pncp.gov.br/app/editais/1",
  },
};

beforeEach(() => {
  findAccountMock.mockReset();
  sendMock.mockReset();
});

describe("dispatchAlertEmail", () => {
  it("envia para o email da CONTA, resolvido na hora do envio", async () => {
    findAccountMock.mockResolvedValueOnce({ customer_id: "cust-1", email: "cliente@exemplo.com" });
    sendMock.mockResolvedValueOnce({ provider: "zeptomail", providerMessageId: "req-1" });

    const result = await dispatchAlertEmail("cust-1", payload);

    expect(result).toEqual({ success: true });
    expect(findAccountMock).toHaveBeenCalledWith("cust-1");
    const message = sendMock.mock.calls[0][0];
    expect(message.to).toEqual([{ address: "cliente@exemplo.com" }]);
    expect(message.subject).toContain("GO");
    expect(message.html).toContain("Aquisicao de merenda escolar");
    expect(message.clientReference).toBe("filter-1:12345/2026");
  });

  it("falha (sem enviar) quando a conta nao tem email cadastrado", async () => {
    findAccountMock.mockResolvedValueOnce({ customer_id: "cust-1" });

    const result = await dispatchAlertEmail("cust-1", payload);

    expect(result.success).toBe(false);
    expect(result.error).toContain("conta sem email");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("falha (sem enviar) quando a conta nao existe", async () => {
    findAccountMock.mockResolvedValueOnce(undefined);

    const result = await dispatchAlertEmail("cust-1", payload);

    expect(result.success).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("converte falha do provider em resultado de entrega, com o status para o log", async () => {
    findAccountMock.mockResolvedValueOnce({ email: "cliente@exemplo.com" });
    sendMock.mockRejectedValueOnce(
      new EmailDeliveryError("ZeptoMail recusou o envio (HTTP 400)", "zeptomail", { status: 400 }),
    );

    const result = await dispatchAlertEmail("cust-1", payload);

    expect(result).toEqual({
      success: false,
      statusCode: 400,
      error: "ZeptoMail recusou o envio (HTTP 400)",
    });
  });

  it("converte mensagem invalida em falha de entrega (nao derruba a fila)", async () => {
    findAccountMock.mockResolvedValueOnce({ email: "torto@" });
    sendMock.mockRejectedValueOnce(new EmailValidationError("endereco de email invalido em to[0]"));

    const result = await dispatchAlertEmail("cust-1", payload);

    expect(result.success).toBe(false);
    expect(result.error).toContain("endereco de email invalido");
  });

  it("propaga erro inesperado -- bug nosso nao vira 'entrega falhou' silenciosa", async () => {
    findAccountMock.mockResolvedValueOnce({ email: "cliente@exemplo.com" });
    sendMock.mockRejectedValueOnce(new TypeError("undefined is not a function"));

    await expect(dispatchAlertEmail("cust-1", payload)).rejects.toThrow(TypeError);
  });
});
