import { describe, expect, it } from "vitest";
import { generateWebhookSecret, signPayload } from "./hmac";

describe("generateWebhookSecret", () => {
  it("gera string hex de 64 caracteres (32 bytes)", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gera segredos diferentes a cada chamada (CSPRNG)", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
  });
});

describe("signPayload", () => {
  it("e deterministico: mesmo secret + mesmo body sempre gera a mesma assinatura", () => {
    const a = signPayload("segredo", '{"event":"tender.matched"}');
    const b = signPayload("segredo", '{"event":"tender.matched"}');
    expect(a).toBe(b);
  });

  it("gera assinaturas diferentes para segredos diferentes com o mesmo body", () => {
    const a = signPayload("segredo-1", "corpo");
    const b = signPayload("segredo-2", "corpo");
    expect(a).not.toBe(b);
  });

  it("gera assinaturas diferentes quando o body muda", () => {
    const a = signPayload("segredo", "corpo-1");
    const b = signPayload("segredo", "corpo-2");
    expect(a).not.toBe(b);
  });

  it("retorna hex de 64 caracteres (SHA-256)", () => {
    expect(signPayload("segredo", "corpo")).toMatch(/^[0-9a-f]{64}$/);
  });
});
