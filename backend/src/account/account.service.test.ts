import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

const getMonthlyUsageMock = vi.fn();
vi.mock("../mcp/usage.service", () => ({
  getMonthlyUsage: (...args: unknown[]) => getMonthlyUsageMock(...args),
}));

const getDailyUsageForLast30DaysMock = vi.fn();
vi.mock("../common/usage-daily.repository", () => ({
  getDailyUsageForLast30Days: (...args: unknown[]) => getDailyUsageForLast30DaysMock(...args),
  last30DayDates: () => {
    const dates: string[] = [];
    const now = new Date("2026-09-07T00:00:00.000Z");
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  },
}));

const createCustomerMock = vi.fn();
const createSubscriptionMock = vi.fn();
const getFirstPaymentForSubscriptionMock = vi.fn();
const getPixQrCodeMock = vi.fn();
vi.mock("../billing/asaas-client", () => ({
  createCustomer: (...args: unknown[]) => createCustomerMock(...args),
  createSubscription: (...args: unknown[]) => createSubscriptionMock(...args),
  getFirstPaymentForSubscription: (...args: unknown[]) => getFirstPaymentForSubscriptionMock(...args),
  getPixQrCode: (...args: unknown[]) => getPixQrCodeMock(...args),
}));

// Import depois dos mocks (hoisted pelo vitest).
import {
  getAccountDailyUsage,
  getAccountInfo,
  getAccountUsage,
  getSubscriptionStatus,
  provisionAccount,
  startCheckout,
} from "./account.service";

beforeEach(() => {
  sendMock.mockReset();
  getMonthlyUsageMock.mockReset();
  getDailyUsageForLast30DaysMock.mockReset();
  createCustomerMock.mockReset();
  createSubscriptionMock.mockReset();
  getFirstPaymentForSubscriptionMock.mockReset();
  getPixQrCodeMock.mockReset();
});

describe("provisionAccount", () => {
  it("cria uma conta nova (plano free) e devolve a api_key crua na primeira chamada", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] }); // findAccountByCustomerId (GSI)
    sendMock.mockResolvedValueOnce({}); // putAccount

    const result = await provisionAccount("cognito-sub-1", "user@example.com");

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(sendMock.mock.calls[1][0]).toBeInstanceOf(PutCommand);
    expect(result.customer_id).toBe("cognito-sub-1");
    expect(result.plan_tier).toBe("free");
    expect(result.has_api_key).toBe(true);
    expect(result.api_key).toBeDefined();
    expect(result.api_key).toHaveLength(64); // randomBytes(32).toString("hex")
  });

  it("e' idempotente: chamada seguinte NAO expoe api_key de novo", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          api_key_hash: "hash-existente",
          customer_id: "cognito-sub-1",
          plan_tier: "starter",
          active: true,
          created_at: "2026-01-01T00:00:00.000Z",
          email: "user@example.com",
        },
      ],
    });

    const result = await provisionAccount("cognito-sub-1", "user@example.com");

    expect(sendMock).toHaveBeenCalledTimes(1); // so leu, nao escreveu de novo
    expect(result.plan_tier).toBe("starter");
    expect(result.has_api_key).toBe(true);
    expect(result.api_key).toBeUndefined();
  });
});

describe("getAccountInfo", () => {
  it("retorna os dados da conta sem a api key", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          api_key_hash: "hash-1",
          customer_id: "cognito-sub-1",
          plan_tier: "starter",
          active: true,
          created_at: "2026-01-01T00:00:00.000Z",
          email: "user@example.com",
        },
      ],
    });

    const info = await getAccountInfo("cognito-sub-1");

    expect(info).toEqual({
      customer_id: "cognito-sub-1",
      email: "user@example.com",
      plan_tier: "starter",
      created_at: "2026-01-01T00:00:00.000Z",
      has_api_key: true,
    });
    expect((info as unknown as Record<string, unknown>).api_key).toBeUndefined();
  });

  it("lanca 404 quando a conta nao existe", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    await expect(getAccountInfo("cognito-sub-x")).rejects.toMatchObject({ status: 404 });
  });
});

describe("getAccountUsage", () => {
  it("busca a conta pra saber o plan_tier e delega pra getMonthlyUsage", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ api_key_hash: "hash-1", customer_id: "cognito-sub-1", plan_tier: "pro", created_at: "2026-01-01T00:00:00.000Z" }],
    });
    getMonthlyUsageMock.mockResolvedValueOnce({
      plan: "Pro",
      requestsThisMonth: 10,
      monthlyLimit: 50000,
      monthlyRemaining: 49990,
      perMinuteLimit: 600,
    });

    const usage = await getAccountUsage("cognito-sub-1");

    expect(getMonthlyUsageMock).toHaveBeenCalledWith("cognito-sub-1", "pro");
    expect(usage.monthlyRemaining).toBe(49990);
  });
});

describe("startCheckout", () => {
  const existingAccount = {
    api_key_hash: "hash-1",
    customer_id: "cognito-sub-1",
    plan_tier: "free" as const,
    active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    email: "user@example.com",
  };

  it("rejeita plan invalido antes de tocar no DynamoDB/Asaas", async () => {
    await expect(
      startCheckout("cognito-sub-1", { plan: "free" as never, cpfCnpj: "12345678901", name: "Fulano" }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejeita cpfCnpj com formato invalido", async () => {
    await expect(
      startCheckout("cognito-sub-1", { plan: "pro", cpfCnpj: "123", name: "Fulano" }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  });

  it("cria customer no Asaas (primeira vez), assinatura, e persiste invoiceUrl/pending_plan_tier", async () => {
    sendMock.mockResolvedValueOnce({ Items: [existingAccount] }); // findAccountByCustomerId
    sendMock.mockResolvedValueOnce({}); // updateAccountFields (asaas_customer_id)
    sendMock.mockResolvedValueOnce({}); // updateAccountFields (asaas_subscription_id/pending/checkout_url)

    createCustomerMock.mockResolvedValueOnce({ id: "cus_asaas_123", name: "Fulano", cpfCnpj: "12345678901" });
    createSubscriptionMock.mockResolvedValueOnce({
      id: "sub_asaas_456",
      customer: "cus_asaas_123",
      billingType: "UNDEFINED",
      cycle: "MONTHLY",
      value: 49,
      nextDueDate: "2026-09-07",
      status: "ACTIVE",
    });
    getFirstPaymentForSubscriptionMock.mockResolvedValueOnce({
      id: "pay_789",
      customer: "cus_asaas_123",
      subscription: "sub_asaas_456",
      value: 49,
      status: "PENDING",
      billingType: "UNDEFINED",
      invoiceUrl: "https://www.asaas.com/i/pay_789",
    });
    getPixQrCodeMock.mockRejectedValueOnce(new Error("pix indisponivel"));

    const result = await startCheckout("cognito-sub-1", { plan: "starter", cpfCnpj: "123.456.789-01", name: "Fulano" });

    expect(createCustomerMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Fulano", cpfCnpj: "12345678901", email: "user@example.com" }),
    );
    expect(createSubscriptionMock).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_asaas_123", value: 49 }));
    expect(result.checkout_url).toBe("https://www.asaas.com/i/pay_789");
    expect(result.pix_qr_code).toBeUndefined();
    expect(result.asaas_subscription_id).toBe("sub_asaas_456");
  });

  it("reusa asaas_customer_id ja existente, sem chamar createCustomer de novo", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ ...existingAccount, asaas_customer_id: "cus_ja_existe" }],
    });
    sendMock.mockResolvedValueOnce({}); // updateAccountFields final

    createSubscriptionMock.mockResolvedValueOnce({
      id: "sub_2",
      customer: "cus_ja_existe",
      billingType: "UNDEFINED",
      cycle: "MONTHLY",
      value: 149,
      nextDueDate: "2026-09-07",
      status: "ACTIVE",
    });
    getFirstPaymentForSubscriptionMock.mockResolvedValueOnce({
      id: "pay_2",
      customer: "cus_ja_existe",
      subscription: "sub_2",
      value: 149,
      status: "PENDING",
      billingType: "PIX",
      invoiceUrl: "https://www.asaas.com/i/pay_2",
    });
    getPixQrCodeMock.mockResolvedValueOnce({ encodedImage: "base64img", payload: "pix-copia-cola", expirationDate: "2026-09-08" });

    const result = await startCheckout("cognito-sub-1", { plan: "pro", cpfCnpj: "12345678901", name: "Fulano" });

    expect(createCustomerMock).not.toHaveBeenCalled();
    expect(result.pix_qr_code).toEqual({ encoded_image: "base64img", payload: "pix-copia-cola", expiration_date: "2026-09-08" });
  });

  it("lanca 404 quando a conta nao esta provisionada", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    await expect(
      startCheckout("cognito-sub-sem-conta", { plan: "starter", cpfCnpj: "12345678901", name: "Fulano" }),
    ).rejects.toMatchObject({ status: 404, code: "ACCOUNT_NOT_PROVISIONED" });
  });
});

describe("getSubscriptionStatus", () => {
  it("retorna plan_tier atual e checkout pendente quando ainda nao confirmado", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          api_key_hash: "hash-1",
          customer_id: "cognito-sub-1",
          plan_tier: "free",
          created_at: "2026-01-01T00:00:00.000Z",
          pending_plan_tier: "pro",
          checkout_invoice_url: "https://www.asaas.com/i/pay_x",
        },
      ],
    });

    const status = await getSubscriptionStatus("cognito-sub-1");

    expect(status).toEqual({ plan_tier: "free", pending_plan_tier: "pro", checkout_url: "https://www.asaas.com/i/pay_x" });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("limpa o checkout pendente quando plan_tier ja bateu com pending_plan_tier (webhook confirmou)", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          api_key_hash: "hash-1",
          customer_id: "cognito-sub-1",
          plan_tier: "pro",
          created_at: "2026-01-01T00:00:00.000Z",
          pending_plan_tier: "pro",
          checkout_invoice_url: "https://www.asaas.com/i/pay_x",
        },
      ],
    });
    sendMock.mockResolvedValueOnce({}); // clearPendingCheckout

    const status = await getSubscriptionStatus("cognito-sub-1");

    expect(status).toEqual({ plan_tier: "pro", pending_plan_tier: null, checkout_url: null });
    expect(sendMock.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
  });

  it("lanca 404 quando a conta nao existe", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    await expect(getSubscriptionStatus("cognito-sub-x")).rejects.toMatchObject({ status: 404 });
  });
});

describe("getAccountDailyUsage", () => {
  it("zero-preenche os 30 dias sem linha em UsageDaily", async () => {
    getDailyUsageForLast30DaysMock.mockResolvedValueOnce(new Map());

    const result = await getAccountDailyUsage("cognito-sub-1");

    expect(result.days).toHaveLength(30);
    expect(
      result.days.every(
        (d) => d.api_count === 0 && d.mcp_count === 0 && d.ui_count === 0 && d.webhook_count === 0 && d.email_count === 0 && d.total_count === 0,
      ),
    ).toBe(true);
    expect(result.totals).toEqual({ api: 0, mcp: 0, ui: 0, webhook: 0, email: 0 });
    expect(result.days[0].date).toBe("2026-08-09"); // mais antigo primeiro
    expect(result.days[29].date).toBe("2026-09-07"); // mais recente por ultimo
  });

  it("combina os dias com dado real e soma os totais por canal corretamente", async () => {
    getDailyUsageForLast30DaysMock.mockResolvedValueOnce(
      new Map([
        ["2026-09-07", { api_count: 10, mcp_count: 3, ui_count: 4, webhook_count: 1, email_count: 2 }],
        ["2026-09-05", { api_count: 2, mcp_count: 0, ui_count: 1, webhook_count: 0, email_count: 0 }],
      ]),
    );

    const result = await getAccountDailyUsage("cognito-sub-1");

    const day07 = result.days.find((d) => d.date === "2026-09-07");
    expect(day07).toEqual({ date: "2026-09-07", api_count: 10, mcp_count: 3, ui_count: 4, webhook_count: 1, email_count: 2, total_count: 20 });
    expect(result.totals).toEqual({ api: 12, mcp: 3, ui: 5, webhook: 1, email: 2 });
  });
});
