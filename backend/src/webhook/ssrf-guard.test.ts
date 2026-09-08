import { promises as dns } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isBlockedIp, resolveAndAssertSafe, SsrfBlockedError } from "./ssrf-guard";

describe("isBlockedIp (IPv4)", () => {
  it("bloqueia 169.254.169.254 (metadata service AWS)", () => {
    expect(isBlockedIp("169.254.169.254", 4)).toBe(true);
  });

  it("bloqueia ranges RFC1918 (10/8, 172.16/12, 192.168/16)", () => {
    expect(isBlockedIp("10.0.0.1", 4)).toBe(true);
    expect(isBlockedIp("172.16.0.1", 4)).toBe(true);
    expect(isBlockedIp("172.31.255.254", 4)).toBe(true);
    expect(isBlockedIp("192.168.1.1", 4)).toBe(true);
  });

  it("bloqueia loopback 127.0.0.0/8", () => {
    expect(isBlockedIp("127.0.0.1", 4)).toBe(true);
    expect(isBlockedIp("127.255.255.255", 4)).toBe(true);
  });

  it("bloqueia 0.0.0.0/8", () => {
    expect(isBlockedIp("0.0.0.0", 4)).toBe(true);
  });

  it("bloqueia CGNAT 100.64.0.0/10 (inclui metadata da Alibaba Cloud 100.100.100.200)", () => {
    expect(isBlockedIp("100.64.0.1", 4)).toBe(true);
    expect(isBlockedIp("100.100.100.200", 4)).toBe(true);
    expect(isBlockedIp("100.127.255.255", 4)).toBe(true);
  });

  it("nao bloqueia IP publico normal", () => {
    expect(isBlockedIp("8.8.8.8", 4)).toBe(false);
    expect(isBlockedIp("1.1.1.1", 4)).toBe(false);
  });

  it("nao bloqueia IP logo fora do range CGNAT (limite exato)", () => {
    expect(isBlockedIp("100.63.255.255", 4)).toBe(false);
    expect(isBlockedIp("100.128.0.0", 4)).toBe(false);
  });
});

describe("isBlockedIp (IPv6)", () => {
  it("bloqueia loopback ::1 e endereco totalmente zerado ::", () => {
    expect(isBlockedIp("::1", 6)).toBe(true);
    expect(isBlockedIp("::", 6)).toBe(true);
  });

  it("bloqueia fc00::/7 (Unique Local Address, equivalente IPv6 do RFC1918)", () => {
    expect(isBlockedIp("fc00::1", 6)).toBe(true);
    expect(isBlockedIp("fd00::1", 6)).toBe(true);
  });

  it("bloqueia o metadata IPv6 real da AWS (fd00:ec2::254) -- achado real da revisao de seguranca", () => {
    expect(isBlockedIp("fd00:ec2::254", 6)).toBe(true);
  });

  it("bloqueia fe80::/10 (link-local)", () => {
    expect(isBlockedIp("fe80::1", 6)).toBe(true);
  });

  it("bloqueia enderecos IPv4-mapeados que caem em range IPv4 bloqueado (bypass classico)", () => {
    expect(isBlockedIp("::ffff:169.254.169.254", 6)).toBe(true);
    expect(isBlockedIp("::ffff:127.0.0.1", 6)).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1", 6)).toBe(true);
  });

  it("nao bloqueia IPv6 publico normal", () => {
    expect(isBlockedIp("2001:4860:4860::8888", 6)).toBe(false);
  });

  it("nao bloqueia endereco IPv4-mapeado que aponta pra IP publico", () => {
    expect(isBlockedIp("::ffff:8.8.8.8", 6)).toBe(false);
  });
});

describe("resolveAndAssertSafe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejeita URL malformada antes de tentar resolver", async () => {
    await expect(resolveAndAssertSafe("nao-e-url")).rejects.toThrow(SsrfBlockedError);
  });

  it("rejeita protocolo diferente de http/https", async () => {
    await expect(resolveAndAssertSafe("ftp://exemplo.com")).rejects.toThrow(SsrfBlockedError);
  });

  it("rejeita quando o hostname resolve pra um IP bloqueado", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "169.254.169.254", family: 4 },
    ] as never);
    await expect(resolveAndAssertSafe("https://metadata.exemplo.com/webhook")).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it("rejeita quando QUALQUER um dos IPs resolvidos e bloqueado (multi-A record)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    await expect(resolveAndAssertSafe("https://exemplo.com/webhook")).rejects.toThrow(SsrfBlockedError);
  });

  it("resolve com sucesso quando o IP e publico", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    const result = await resolveAndAssertSafe("https://exemplo.com/webhook");
    expect(result).toEqual({ hostname: "exemplo.com", ip: "8.8.8.8", family: 4 });
  });

  it("propaga como SsrfBlockedError quando a resolucao DNS falha", async () => {
    vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
    await expect(resolveAndAssertSafe("https://naoexiste.invalid/webhook")).rejects.toThrow(
      SsrfBlockedError,
    );
  });
});
