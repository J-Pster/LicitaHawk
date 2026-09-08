import { describe, expect, it } from "vitest";
import { createEmailConnector, EMAIL_PROVIDER_NAMES } from "./connector-registry";

describe("createEmailConnector", () => {
  it.each(EMAIL_PROVIDER_NAMES)("cria o connector registrado '%s' com o nome batendo", (name) => {
    expect(createEmailConnector(name).name).toBe(name);
  });

  it("falha no boot com nome desconhecido, listando os validos", () => {
    expect(() => createEmailConnector("sendgrid")).toThrow(/EMAIL_PROVIDER="sendgrid" desconhecido/);
    expect(() => createEmailConnector("sendgrid")).toThrow(new RegExp(EMAIL_PROVIDER_NAMES.join(", ")));
  });

  it("nao aceita nome vazio nem chave herdada de Object.prototype", () => {
    expect(() => createEmailConnector("")).toThrow(/desconhecido/);
    expect(() => createEmailConnector("toString")).toThrow(/desconhecido/);
  });
});
