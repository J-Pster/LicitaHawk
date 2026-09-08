import { beforeEach, describe, expect, it, vi } from "vitest";

const listPaymentsByStatusSinceMock = vi.fn();
const getPaymentByIdMock = vi.fn();
const { FakeAsaasApiError } = vi.hoisted(() => {
  class FakeAsaasApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "AsaasApiError";
      this.status = status;
    }
  }
  return { FakeAsaasApiError };
});
vi.mock("./asaas-client", () => ({
  AsaasApiError: FakeAsaasApiError,
  listPaymentsByStatusSince: (...args: unknown[]) => listPaymentsByStatusSinceMock(...args),
  getPaymentById: (...args: unknown[]) => getPaymentByIdMock(...args),
}));

const setPlanTierForAsaasCustomerMock = vi.fn();
vi.mock("./customer-plan-sync", () => ({
  setPlanTierForAsaasCustomer: (...args: unknown[]) => setPlanTierForAsaasCustomerMock(...args),
}));

const opsAlertMock = vi.fn();
vi.mock("../common/ops-alert", () => ({
  opsAlert: (...args: unknown[]) => opsAlertMock(...args),
}));

import { reconcilePlanTiers } from "./reconciliation.service";

function payment(overrides: Partial<{ id: string; customer: string; value: number; status: string }> = {}) {
  return {
    id: "pay_1",
    customer: "cus_1",
    value: 149,
    status: "CONFIRMED",
    ...overrides,
  };
}

beforeEach(() => {
  listPaymentsByStatusSinceMock.mockReset();
  getPaymentByIdMock.mockReset();
  setPlanTierForAsaasCustomerMock.mockReset();
  opsAlertMock.mockReset();
  // Por padrao: sem pagamentos em nenhum dos 2 status (CONFIRMED/RECEIVED) -- cada teste
  // sobrescreve o que precisa via mockImplementation/mockResolvedValueOnce.
  listPaymentsByStatusSinceMock.mockResolvedValue([]);
});

describe("reconcilePlanTiers", () => {
  it("sincroniza plan_tier quando o pagamento CONFIRMED bate com um plano conhecido", async () => {
    listPaymentsByStatusSinceMock.mockImplementation(async (status: string) =>
      status === "CONFIRMED" ? [payment()] : [],
    );
    getPaymentByIdMock.mockResolvedValue(payment({ status: "CONFIRMED" }));
    setPlanTierForAsaasCustomerMock.mockResolvedValue({ updatedCount: 1, customerId: "cust-1", previousTier: "free" });

    const result = await reconcilePlanTiers();

    expect(result).toEqual({ checked: 1, driftFound: 1, driftFixed: 1, errors: 0 });
    expect(setPlanTierForAsaasCustomerMock).toHaveBeenCalledWith("cus_1", "pro");
    expect(opsAlertMock).toHaveBeenCalledWith(
      "billing_reconciliation_drift_fixed",
      "warning",
      expect.objectContaining({ asaas_customer_id: "cus_1", asaas_payment_id: "pay_1", corrected_tier: "pro" }),
    );
  });

  it("nao escreve nada (nem alerta) quando o tier local ja bate -- idempotente", async () => {
    listPaymentsByStatusSinceMock.mockImplementation(async (status: string) =>
      status === "CONFIRMED" ? [payment()] : [],
    );
    getPaymentByIdMock.mockResolvedValue(payment({ status: "CONFIRMED" }));
    setPlanTierForAsaasCustomerMock.mockResolvedValue({ updatedCount: 0, customerId: "cust-1", previousTier: "pro" });

    const result = await reconcilePlanTiers();

    expect(result).toEqual({ checked: 1, driftFound: 0, driftFixed: 0, errors: 0 });
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it("ignora pagamento cujo valor nao corresponde a nenhum plano conhecido", async () => {
    listPaymentsByStatusSinceMock.mockImplementation(async (status: string) =>
      status === "CONFIRMED" ? [payment({ value: 12345 })] : [],
    );

    const result = await reconcilePlanTiers();

    expect(result).toEqual({ checked: 1, driftFound: 0, driftFixed: 0, errors: 0 });
    expect(getPaymentByIdMock).not.toHaveBeenCalled();
    expect(setPlanTierForAsaasCustomerMock).not.toHaveBeenCalled();
  });

  it("REGRESSAO (Rodada 9 -- race de escrita): pula e NAO reescreve plan_tier quando a releitura mostra que o pagamento ja nao esta mais CONFIRMED/RECEIVED (estorno/chargeback chegou via webhook depois da listagem)", async () => {
    listPaymentsByStatusSinceMock.mockImplementation(async (status: string) =>
      status === "CONFIRMED" ? [payment({ status: "CONFIRMED" })] : [],
    );
    // Releitura pontual mostra que o Asaas ja moveu o pagamento pra REFUNDED -- um webhook de
    // estorno em tempo real ja rodou downgradeToFreeForAsaasCustomer nesse meio-tempo.
    getPaymentByIdMock.mockResolvedValue(payment({ status: "REFUNDED" }));

    const result = await reconcilePlanTiers();

    expect(result).toEqual({ checked: 1, driftFound: 0, driftFixed: 0, errors: 0 });
    expect(setPlanTierForAsaasCustomerMock).not.toHaveBeenCalled();
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it("REGRESSAO (Rodada 9): pula quando a releitura mostra CHARGEBACK_REQUESTED, mesmo pagamento tendo vindo da listagem CONFIRMED", async () => {
    listPaymentsByStatusSinceMock.mockImplementation(async (status: string) =>
      status === "CONFIRMED" ? [payment({ status: "CONFIRMED" })] : [],
    );
    getPaymentByIdMock.mockResolvedValue(payment({ status: "CHARGEBACK_REQUESTED" }));

    await reconcilePlanTiers();

    expect(setPlanTierForAsaasCustomerMock).not.toHaveBeenCalled();
  });

  it("chama getPaymentById com o id do pagamento antes de escrever o tier (releitura acontece de fato, nao so em teoria)", async () => {
    listPaymentsByStatusSinceMock.mockImplementation(async (status: string) =>
      status === "RECEIVED" ? [payment({ id: "pay_xyz", status: "RECEIVED" })] : [],
    );
    getPaymentByIdMock.mockResolvedValue(payment({ id: "pay_xyz", status: "RECEIVED" }));
    setPlanTierForAsaasCustomerMock.mockResolvedValue({ updatedCount: 0 });

    await reconcilePlanTiers();

    expect(getPaymentByIdMock).toHaveBeenCalledWith("pay_xyz");
    expect(getPaymentByIdMock).toHaveBeenCalledTimes(1);
  });

  it("registra erro e alerta quando a listagem por status falha, mas continua pro proximo status sem lancar", async () => {
    listPaymentsByStatusSinceMock.mockImplementation(async (status: string) => {
      if (status === "CONFIRMED") throw new FakeAsaasApiError("boom", 500);
      return [payment({ status: "RECEIVED" })];
    });
    getPaymentByIdMock.mockResolvedValue(payment({ status: "RECEIVED" }));
    setPlanTierForAsaasCustomerMock.mockResolvedValue({ updatedCount: 1, previousTier: "free" });

    const result = await reconcilePlanTiers();

    expect(result).toEqual({ checked: 1, driftFound: 1, driftFixed: 1, errors: 1 });
    expect(opsAlertMock).toHaveBeenCalledWith(
      "billing_reconciliation_fetch_failed",
      "warning",
      expect.objectContaining({ status: "CONFIRMED", error: "HTTP 500" }),
    );
  });

  it("registra erro e alerta quando a releitura pontual (getPaymentById) falha, sem lancar pro chamador", async () => {
    listPaymentsByStatusSinceMock.mockImplementation(async (status: string) =>
      status === "CONFIRMED" ? [payment()] : [],
    );
    getPaymentByIdMock.mockRejectedValue(new Error("timeout de rede"));

    const result = await reconcilePlanTiers();

    expect(result).toEqual({ checked: 1, driftFound: 0, driftFixed: 0, errors: 1 });
    expect(setPlanTierForAsaasCustomerMock).not.toHaveBeenCalled();
    expect(opsAlertMock).toHaveBeenCalledWith(
      "billing_reconciliation_sync_failed",
      "warning",
      expect.objectContaining({ asaas_payment_id: "pay_1", error: "timeout de rede" }),
    );
  });

  it("registra erro e alerta quando setPlanTierForAsaasCustomer falha, sem interromper os demais pagamentos", async () => {
    listPaymentsByStatusSinceMock.mockImplementation(async (status: string) =>
      status === "CONFIRMED" ? [payment({ id: "pay_a", customer: "cus_a" }), payment({ id: "pay_b", customer: "cus_b" })] : [],
    );
    getPaymentByIdMock.mockImplementation(async (id: string) => payment({ id, status: "CONFIRMED" }));
    setPlanTierForAsaasCustomerMock
      .mockRejectedValueOnce(new Error("dynamo indisponivel"))
      .mockResolvedValueOnce({ updatedCount: 1, previousTier: "free" });

    const result = await reconcilePlanTiers();

    expect(result).toEqual({ checked: 2, driftFound: 1, driftFixed: 1, errors: 1 });
    expect(setPlanTierForAsaasCustomerMock).toHaveBeenCalledTimes(2);
  });

  it("consulta os 2 status de reconciliacao (CONFIRMED e RECEIVED) em toda execucao", async () => {
    await reconcilePlanTiers();

    expect(listPaymentsByStatusSinceMock).toHaveBeenCalledTimes(2);
    expect(listPaymentsByStatusSinceMock).toHaveBeenCalledWith("CONFIRMED", expect.any(String));
    expect(listPaymentsByStatusSinceMock).toHaveBeenCalledWith("RECEIVED", expect.any(String));
  });
});
