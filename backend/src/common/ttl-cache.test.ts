import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "./ttl-cache";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TtlCache", () => {
  it("retorna undefined para chave nunca gravada", () => {
    const cache = new TtlCache<string>(1000);
    expect(cache.get("nunca-gravada")).toBeUndefined();
  });

  it("retorna o valor gravado enquanto o TTL nao expira", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("k", "v");
    vi.advanceTimersByTime(999);
    expect(cache.get("k")).toBe("v");
  });

  it("expira exatamente quando o TTL e alcancado e remove a entrada", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("k", "v");
    vi.advanceTimersByTime(1000);
    expect(cache.get("k")).toBeUndefined();
  });

  it("expira apos o TTL passar", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("k", "v");
    vi.advanceTimersByTime(1500);
    expect(cache.get("k")).toBeUndefined();
  });

  it("sobrescrever uma chave existente reinicia o TTL dela", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("k", "v1");
    vi.advanceTimersByTime(800);
    cache.set("k", "v2");
    vi.advanceTimersByTime(800); // 1600ms desde o 1o set, mas so 800ms desde o 2o
    expect(cache.get("k")).toBe("v2");
  });

  it("armazena valores falsy (0, '', false) e distingue de 'nao encontrado'", () => {
    const cache = new TtlCache<number | string | boolean | null>(1000);
    cache.set("zero", 0);
    cache.set("vazio", "");
    cache.set("falso", false);
    cache.set("nulo", null);
    expect(cache.get("zero")).toBe(0);
    expect(cache.get("vazio")).toBe("");
    expect(cache.get("falso")).toBe(false);
    expect(cache.get("nulo")).toBeNull();
  });

  it("faz eviction FIFO (chave mais antiga) quando maxEntries e atingido", () => {
    const cache = new TtlCache<string>(1000, 3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.set("d", "4"); // deve evictar "a" (a mais antiga)

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");
  });

  it("nao faz eviction ao sobrescrever uma chave ja existente mesmo no limite de capacidade", () => {
    const cache = new TtlCache<string>(1000, 2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("a", "1-atualizado"); // "a" ja existe -- nao deve disparar eviction de "b"

    expect(cache.get("a")).toBe("1-atualizado");
    expect(cache.get("b")).toBe("2");
  });

  it("maxEntries padrao e 500 quando nao informado", () => {
    const cache = new TtlCache<number>(60_000);
    for (let i = 0; i < 500; i++) cache.set(`k${i}`, i);
    expect(cache.get("k0")).toBe(0); // ainda dentro do limite, nao evictado

    cache.set("k500", 500); // 501a chave -- deve evictar k0
    expect(cache.get("k0")).toBeUndefined();
    expect(cache.get("k500")).toBe(500);
  });
});
