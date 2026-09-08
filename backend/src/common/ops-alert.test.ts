import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { opsAlert } from "./ops-alert";

describe("opsAlert", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("emite uma unica linha JSON em stderr com severity/event/timestamp/contexto", () => {
    opsAlert("billing_plan_downgraded", "critical", { customer_id: "cust-1", reason: "PAYMENT_REFUNDED" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[ops-alert\] /);
    const parsed = JSON.parse(line.replace("[ops-alert] ", ""));
    expect(parsed).toMatchObject({
      ops_alert: true,
      severity: "critical",
      event: "billing_plan_downgraded",
      customer_id: "cust-1",
      reason: "PAYMENT_REFUNDED",
    });
    expect(typeof parsed.timestamp).toBe("string");
    expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow();
  });

  it("funciona sem contexto explicito (parametro opcional)", () => {
    opsAlert("webhook_filter_circuit_breaker_open", "warning");

    const line = errorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line.replace("[ops-alert] ", ""));
    expect(parsed.event).toBe("webhook_filter_circuit_breaker_open");
    expect(parsed.severity).toBe("warning");
  });

  it("NUNCA lanca, mesmo quando o contexto tem uma referencia circular que quebra JSON.stringify", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    expect(() => opsAlert("evento_qualquer", "warning", circular)).not.toThrow();
  });

  it("nao propaga falha do proprio console.error (observabilidade nao pode derrubar o caminho real)", () => {
    errorSpy.mockImplementation(() => {
      throw new Error("stderr indisponivel");
    });

    expect(() => opsAlert("evento_qualquer", "critical", {})).not.toThrow();
  });
});
