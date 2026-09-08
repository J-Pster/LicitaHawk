import { describe, expect, it } from "vitest";
import { EmailPort, EmailSendResult, OutboundEmail } from "../common/ports/email-port";
import { EmailValidationError } from "./email.errors";
import { EmailService } from "./email.service";

class FakeConnector implements EmailPort {
  readonly name = "fake";
  readonly sent: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<EmailSendResult> {
    this.sent.push(email);
    return { provider: this.name, providerMessageId: "fake-1" };
  }
}

const DEFAULT_FROM = { address: "noreply@licitahawk.com", name: "LicitaHawk" };

function makeService() {
  const connector = new FakeConnector();
  return { connector, service: new EmailService(connector, DEFAULT_FROM) };
}

const validMessage = {
  to: [{ address: "cliente@exemplo.com", name: "Cliente" }],
  subject: "Nova licitacao no seu filtro",
  html: "<p>ola</p>",
};

describe("EmailService", () => {
  it("aplica o remetente default quando a mensagem nao traz `from`", async () => {
    const { connector, service } = makeService();

    const result = await service.send(validMessage);

    expect(connector.sent).toHaveLength(1);
    expect(connector.sent[0].from).toEqual(DEFAULT_FROM);
    expect(result).toEqual({ provider: "fake", providerMessageId: "fake-1" });
  });

  it("respeita um `from` explicito", async () => {
    const { connector, service } = makeService();

    await service.send({ ...validMessage, from: { address: "suporte@licitahawk.com" } });

    expect(connector.sent[0].from).toEqual({ address: "suporte@licitahawk.com" });
  });

  it("repassa corpo, assunto, replyTo e clientReference sem alterar", async () => {
    const { connector, service } = makeService();

    await service.send({
      ...validMessage,
      text: "ola",
      replyTo: [{ address: "contato@licitahawk.com" }],
      clientReference: "invoice-42",
    });

    expect(connector.sent[0]).toMatchObject({
      to: validMessage.to,
      subject: validMessage.subject,
      html: "<p>ola</p>",
      text: "ola",
      replyTo: [{ address: "contato@licitahawk.com" }],
      clientReference: "invoice-42",
    });
  });

  it("expoe o nome do connector configurado", () => {
    const { service } = makeService();

    expect(service.providerName).toBe("fake");
  });

  it("recusa lista de destinatarios vazia", async () => {
    const { connector, service } = makeService();

    await expect(service.send({ ...validMessage, to: [] })).rejects.toBeInstanceOf(EmailValidationError);
    expect(connector.sent).toHaveLength(0);
  });

  it.each([
    ["sem arroba", "cliente.exemplo.com"],
    ["com espaco", "cli ente@exemplo.com"],
    ["sem dominio", "cliente@exemplo"],
    ["vazio", ""],
  ])("recusa destinatario invalido (%s)", async (_caso, address) => {
    const { connector, service } = makeService();

    await expect(service.send({ ...validMessage, to: [{ address }] })).rejects.toBeInstanceOf(
      EmailValidationError,
    );
    expect(connector.sent).toHaveLength(0);
  });

  it("recusa remetente default invalido (erro de configuracao do .env)", async () => {
    const connector = new FakeConnector();
    const service = new EmailService(connector, { address: "noreply@" });

    await expect(service.send(validMessage)).rejects.toBeInstanceOf(EmailValidationError);
  });

  it("recusa replyTo invalido", async () => {
    const { service } = makeService();

    await expect(
      service.send({ ...validMessage, replyTo: [{ address: "nao-e-email" }] }),
    ).rejects.toBeInstanceOf(EmailValidationError);
  });

  it("recusa assunto vazio ou so espaco", async () => {
    const { service } = makeService();

    await expect(service.send({ ...validMessage, subject: "   " })).rejects.toBeInstanceOf(
      EmailValidationError,
    );
  });

  it("recusa mensagem sem corpo (html e text ausentes ou em branco)", async () => {
    const { connector, service } = makeService();

    await expect(
      service.send({ to: validMessage.to, subject: validMessage.subject }),
    ).rejects.toBeInstanceOf(EmailValidationError);
    await expect(
      service.send({ to: validMessage.to, subject: validMessage.subject, html: "  ", text: "" }),
    ).rejects.toBeInstanceOf(EmailValidationError);
    expect(connector.sent).toHaveLength(0);
  });

  it("aceita mensagem so com text (sem html)", async () => {
    const { connector, service } = makeService();

    await service.send({ to: validMessage.to, subject: validMessage.subject, text: "corpo" });

    expect(connector.sent).toHaveLength(1);
  });
});
