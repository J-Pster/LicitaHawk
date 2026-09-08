import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

const sendMock = vi.fn();
vi.mock("../common/dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

// Import depois dos mocks (hoisted pelo vitest).
import { getMonthlyUsage } from "./usage.service";
import { currentYyyymm } from "../common/auth/api-key.middleware";

beforeEach(() => {
  sendMock.mockReset();
});

describe("getMonthlyUsage", () => {
  it("le UsageCounters via GetCommand puro (nunca incrementa)", async () => {
    sendMock.mockResolvedValueOnce({ Item: { customer_id: "cust-1", yyyymm: currentYyyymm(), request_count: 11 } });

    await getMonthlyUsage("cust-1", "pro");

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const input = (sendMock.mock.calls[0][0] as GetCommand).input;
    expect(input.TableName).toBe("UsageCounters");
    expect(input.Key).toEqual({ customer_id: "cust-1", yyyymm: currentYyyymm() });
  });

  it("retorna contadores corretos pro plano pro (limite mensal 50000, por minuto 600)", async () => {
    sendMock.mockResolvedValueOnce({ Item: { request_count: 11 } });

    const usage = await getMonthlyUsage("cust-1", "pro");

    expect(usage).toEqual({
      plan: "Pro",
      requestsThisMonth: 11,
      monthlyLimit: 50000,
      monthlyRemaining: 49989,
      perMinuteLimit: 600,
    });
  });

  it("retorna contadores corretos pro plano free (limite mensal 100, por minuto 30)", async () => {
    sendMock.mockResolvedValueOnce({ Item: { request_count: 4 } });

    const usage = await getMonthlyUsage("cust-2", "free");

    expect(usage).toEqual({
      plan: "Free",
      requestsThisMonth: 4,
      monthlyLimit: 100,
      monthlyRemaining: 96,
      perMinuteLimit: 30,
    });
  });

  it("trata ausencia de item (cliente sem uso registrado ainda) como request_count=0", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });

    const usage = await getMonthlyUsage("cust-novo", "starter");

    expect(usage.requestsThisMonth).toBe(0);
    expect(usage.monthlyRemaining).toBe(5000);
  });

  it("monthlyRemaining nunca fica negativo mesmo se o contador ja ultrapassou o limite", async () => {
    sendMock.mockResolvedValueOnce({ Item: { request_count: 150 } }); // free: limite 100

    const usage = await getMonthlyUsage("cust-estourado", "free");

    expect(usage.requestsThisMonth).toBe(150);
    expect(usage.monthlyRemaining).toBe(0);
  });

  it("propaga erro do DynamoDB sem engolir", async () => {
    sendMock.mockRejectedValueOnce(new Error("timeout de rede"));
    await expect(getMonthlyUsage("cust-1", "pro")).rejects.toThrow("timeout de rede");
  });
});
