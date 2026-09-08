import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const sendMock = vi.fn();
vi.mock("./dynamodb-client", () => ({
  ddbDocClient: { send: (...args: unknown[]) => sendMock(...args) },
}));

// Import depois dos mocks (hoisted pelo vitest).
import { getDailyUsageForLast30Days, incrementDailyUsage, last30DayDates } from "./usage-daily.repository";

beforeEach(() => {
  sendMock.mockReset();
  vi.restoreAllMocks();
});

describe("last30DayDates", () => {
  it("retorna 30 datas unicas, do mais antigo pro mais recente, terminando em hoje", () => {
    const dates = last30DayDates();
    expect(dates).toHaveLength(30);
    expect(new Set(dates).size).toBe(30);
    const today = new Date().toISOString().slice(0, 10);
    expect(dates[29]).toBe(today);
  });
});

describe("incrementDailyUsage", () => {
  it("incrementa api_count via UpdateCommand ADD com TTL de 60 dias", async () => {
    sendMock.mockResolvedValueOnce({});

    await incrementDailyUsage("cust-1", "api");

    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(UpdateCommand);
    const input = (sendMock.mock.calls[0][0] as UpdateCommand).input;
    expect(input.TableName).toBe("UsageDaily");
    expect(input.Key?.customer_id).toBe("cust-1");
    expect(input.UpdateExpression).toContain("ADD api_count :inc");
  });

  it("incrementa mcp_count (nao api_count) quando kind='mcp'", async () => {
    sendMock.mockResolvedValueOnce({});

    await incrementDailyUsage("cust-1", "mcp");

    const input = (sendMock.mock.calls[0][0] as UpdateCommand).input;
    expect(input.UpdateExpression).toContain("ADD mcp_count :inc");
  });

  it("incrementa ui_count quando kind='ui'", async () => {
    sendMock.mockResolvedValueOnce({});

    await incrementDailyUsage("cust-1", "ui");

    const input = (sendMock.mock.calls[0][0] as UpdateCommand).input;
    expect(input.UpdateExpression).toContain("ADD ui_count :inc");
  });

  it("incrementa webhook_count quando kind='webhook'", async () => {
    sendMock.mockResolvedValueOnce({});

    await incrementDailyUsage("cust-1", "webhook");

    const input = (sendMock.mock.calls[0][0] as UpdateCommand).input;
    expect(input.UpdateExpression).toContain("ADD webhook_count :inc");
  });

  it("NUNCA lanca mesmo quando o DynamoDB falha (telemetria nao pode derrubar a requisicao real)", async () => {
    sendMock.mockRejectedValueOnce(new Error("timeout de rede"));
    await expect(incrementDailyUsage("cust-1", "api")).resolves.toBeUndefined();
  });
});

describe("getDailyUsageForLast30Days", () => {
  it("faz uma Query por customer_id + date entre os limites da janela de 30 dias e devolve um Map", async () => {
    const dates = last30DayDates();
    sendMock.mockResolvedValueOnce({
      Items: [
        { customer_id: "cust-1", date: dates[29], api_count: 5, mcp_count: 2, ui_count: 1, webhook_count: 3 },
        { customer_id: "cust-1", date: dates[0], api_count: 1, mcp_count: 0, ui_count: 0, webhook_count: 0 },
      ],
    });

    const result = await getDailyUsageForLast30Days("cust-1");

    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    const input = (sendMock.mock.calls[0][0] as QueryCommand).input;
    expect(input.ExpressionAttributeValues).toMatchObject({ ":cid": "cust-1", ":start": dates[0], ":end": dates[29] });
    expect(result.get(dates[29])).toEqual({ api_count: 5, mcp_count: 2, ui_count: 1, webhook_count: 3, email_count: 0 });
    expect(result.get(dates[0])).toEqual({ api_count: 1, mcp_count: 0, ui_count: 0, webhook_count: 0, email_count: 0 });
    expect(result.has("dia-sem-dado")).toBe(false);
  });

  it("devolve Map vazio quando nao ha nenhuma linha na janela", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    const result = await getDailyUsageForLast30Days("cust-sem-uso");
    expect(result.size).toBe(0);
  });
});
