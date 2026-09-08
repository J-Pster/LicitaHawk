import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutboundEmail } from "../../common/ports/email-port";
import { EmailDeliveryError } from "../email.errors";
import { ZeptoMailConnector } from "./zeptomail.connector";

const email: OutboundEmail = {
  from: { address: "noreply@licitahawk.com", name: "LicitaHawk" },
  to: [{ address: "joao@exemplo.com", name: "Joao" }],
  subject: "Teste",
  html: "<b>ola</b>",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function lastFetchCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init, payload: JSON.parse(init.body as string) };
}

describe("ZeptoMailConnector", () => {
  const originalToken = process.env.ZEPTOMAIL_TOKEN;
  const originalUrl = process.env.ZEPTOMAIL_API_URL;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.ZEPTOMAIL_TOKEN = "Zoho-enczapikey chave-de-teste";
    delete process.env.ZEPTOMAIL_API_URL;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalToken === undefined) delete process.env.ZEPTOMAIL_TOKEN;
    else process.env.ZEPTOMAIL_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.ZEPTOMAIL_API_URL;
    else process.env.ZEPTOMAIL_API_URL = originalUrl;
  });

  it("posta no endpoint da API com o token e devolve o request_id como providerMessageId", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { request_id: "req-123", message: "OK" }));

    const result = await new ZeptoMailConnector().send(email);

    expect(result).toEqual({ provider: "zeptomail", providerMessageId: "req-123" });
    const { url, init } = lastFetchCall(fetchMock);
    expect(url).toBe("https://api.zeptomail.com/v1.1/email");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Zoho-enczapikey chave-de-teste");
  });

  it("mapeia a mensagem para o formato do ZeptoMail", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { request_id: "req-1" }));

    await new ZeptoMailConnector().send({
      ...email,
      text: "ola",
      replyTo: [{ address: "contato@licitahawk.com", name: "Contato" }],
      clientReference: "invoice-42",
    });

    expect(lastFetchCall(fetchMock).payload).toEqual({
      from: { address: "noreply@licitahawk.com", name: "LicitaHawk" },
      to: [{ email_address: { address: "joao@exemplo.com", name: "Joao" } }],
      subject: "Teste",
      htmlbody: "<b>ola</b>",
      textbody: "ola",
      reply_to: [{ address: "contato@licitahawk.com", name: "Contato" }],
      client_reference: "invoice-42",
    });
  });

  it("omite campos opcionais ausentes em vez de mandar chave vazia", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { request_id: "req-1" }));

    await new ZeptoMailConnector().send(email);

    const { payload } = lastFetchCall(fetchMock);
    expect(payload).not.toHaveProperty("textbody");
    expect(payload).not.toHaveProperty("reply_to");
    expect(payload).not.toHaveProperty("client_reference");
    expect(payload.to[0].email_address).toEqual({ address: "joao@exemplo.com", name: "Joao" });
  });

  it("prefixa o token quando o .env tem so a chave, sem o `Zoho-enczapikey`", async () => {
    process.env.ZEPTOMAIL_TOKEN = "chave-crua";
    fetchMock.mockResolvedValue(jsonResponse(201, { request_id: "req-1" }));

    await new ZeptoMailConnector().send(email);

    const { init } = lastFetchCall(fetchMock);
    expect((init.headers as Record<string, string>).authorization).toBe("Zoho-enczapikey chave-crua");
  });

  it("usa ZEPTOMAIL_API_URL quando definida (datacenter EU/IN)", async () => {
    process.env.ZEPTOMAIL_API_URL = "https://api.zeptomail.eu/v1.1/email";
    fetchMock.mockResolvedValue(jsonResponse(201, { request_id: "req-1" }));

    await new ZeptoMailConnector().send(email);

    expect(lastFetchCall(fetchMock).url).toBe("https://api.zeptomail.eu/v1.1/email");
  });

  it("falha alto quando ZEPTOMAIL_TOKEN nao esta configurado", async () => {
    delete process.env.ZEPTOMAIL_TOKEN;

    await expect(new ZeptoMailConnector().send(email)).rejects.toThrow(/ZEPTOMAIL_TOKEN nao configurado/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("converte erro do provider em EmailDeliveryError com status, code e request_id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: "TM_3201",
          message: "Invalid email address",
          request_id: "req-err-9",
          details: [{ code: "GE_3", message: "not a valid address", target: "to" }],
        },
      }),
    );

    const error = await new ZeptoMailConnector().send(email).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    const delivery = error as EmailDeliveryError;
    expect(delivery.provider).toBe("zeptomail");
    expect(delivery.details).toEqual({ status: 400, providerCode: "TM_3201", providerRequestId: "req-err-9" });
    expect(delivery.message).toContain("Invalid email address");
    expect(delivery.message).toContain("not a valid address");
  });

  it("nao engole corpo de erro nao-JSON (ex.: pagina de gateway)", async () => {
    fetchMock.mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 502 }));

    const error = (await new ZeptoMailConnector().send(email).catch((e: unknown) => e)) as EmailDeliveryError;

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error.details.status).toBe(502);
    expect(error.message).toContain("502 Bad Gateway");
  });

  it("converte falha de rede/timeout em EmailDeliveryError", async () => {
    fetchMock.mockRejectedValue(new Error("The operation was aborted due to timeout"));

    const error = (await new ZeptoMailConnector().send(email).catch((e: unknown) => e)) as EmailDeliveryError;

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error.message).toContain("falha de rede");
    expect(error.message).toContain("aborted due to timeout");
  });
});
