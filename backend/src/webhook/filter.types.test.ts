import { describe, expect, it } from "vitest";
import { isWebhookFilter, parseSavedFilter, SavedWebhookFilter } from "./filter.types";
import { toDeliveryTarget } from "./alert-target";

const base = {
  customer_id: "cust-1",
  filter_id: "filter-1",
  name: null,
  uf: "GO",
  modalidade: "Pregão - Eletrônico",
  active: true,
  consecutive_failures: 0,
  created_at: "2026-09-08T00:00:00.000Z",
  updated_at: "2026-09-08T00:00:00.000Z",
};

describe("parseSavedFilter", () => {
  it("le um filtro de webhook com channel explicito", () => {
    const filter = parseSavedFilter({
      ...base,
      channel: "webhook",
      webhook_url: "https://x.com/hook",
      webhook_secret: "segredo",
    });

    expect(filter.channel).toBe("webhook");
    expect(isWebhookFilter(filter) && filter.webhook_url).toBe("https://x.com/hook");
  });

  it("le um alerta por email", () => {
    const filter = parseSavedFilter({ ...base, channel: "email" });

    expect(filter.channel).toBe("email");
    expect(isWebhookFilter(filter)).toBe(false);
  });

  it("COMPATIBILIDADE: item gravado antes do canal existir (sem `channel`) e' webhook", () => {
    const filter = parseSavedFilter({
      ...base,
      webhook_url: "https://legado.com/hook",
      webhook_secret: "segredo",
    });

    expect(filter.channel).toBe("webhook");
    expect((filter as SavedWebhookFilter).webhook_url).toBe("https://legado.com/hook");
  });
});

describe("toDeliveryTarget", () => {
  it("webhook vira alvo com url e secret", () => {
    const filter = parseSavedFilter({
      ...base,
      channel: "webhook",
      webhook_url: "https://x.com/hook",
      webhook_secret: "segredo",
    });

    expect(toDeliveryTarget(filter)).toEqual({
      channel: "webhook",
      url: "https://x.com/hook",
      secret: "segredo",
    });
  });

  it("email vira alvo sem destinatario -- resolvido no envio, nunca carregado no job", () => {
    const filter = parseSavedFilter({ ...base, channel: "email" });

    expect(toDeliveryTarget(filter)).toEqual({ channel: "email" });
  });
});
