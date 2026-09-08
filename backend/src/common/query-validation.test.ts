import { describe, expect, it } from "vitest";
import {
  assertValidUf,
  assertValidWebhookUrl,
  parseDateRange,
  parseLimit,
  parseModalidadeList,
  parseSort,
  parseUfList,
  parseValorRange,
  stableParamsKey,
} from "./query-validation";
import { HttpError } from "./http-error";

describe("assertValidUf", () => {
  it("aceita UF valida em maiuscula ou minuscula", () => {
    expect(() => assertValidUf("GO")).not.toThrow();
    expect(() => assertValidUf("go")).not.toThrow();
  });

  it("rejeita UF invalida com HttpError 400/VALIDATION_ERROR", () => {
    try {
      assertValidUf("XX");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
      expect((err as HttpError).code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("parseUfList", () => {
  it("retorna undefined quando raw e undefined", () => {
    expect(parseUfList(undefined)).toBeUndefined();
  });

  it("faz parse de lista separada por virgula, normaliza maiuscula e dedupe", () => {
    expect(parseUfList("go,sp,go")).toEqual(["GO", "SP"]);
  });

  it("rejeita mais de 5 valores", () => {
    expect(() => parseUfList("GO,SP,MG,RJ,BA,PR")).toThrow(HttpError);
  });

  it("rejeita se algum valor nao for UF valida", () => {
    expect(() => parseUfList("GO,XX")).toThrow(HttpError);
  });

  it("ignora espacos em branco e valores vazios entre virgulas", () => {
    expect(parseUfList(" GO , SP ,")).toEqual(["GO", "SP"]);
  });
});

describe("parseModalidadeList", () => {
  it("retorna undefined quando raw e undefined", () => {
    expect(parseModalidadeList(undefined)).toBeUndefined();
  });

  it("faz parse e dedupe de nomes do dominio oficial", () => {
    expect(parseModalidadeList("Pregão - Eletrônico,Pregão - Eletrônico,Concorrência - Eletrônica")).toEqual([
      "Pregão - Eletrônico",
      "Concorrência - Eletrônica",
    ]);
  });

  it("rejeita valor fora do dominio oficial do PNCP em vez de devolver lista vazia silenciosamente", () => {
    // A Query casa por igualdade EXATA de string contra `Tender.modalidade` (o `modalidadeNome` cru
    // do PNCP): "Pregão" sozinho nunca casaria com nada e a API responderia 200 com [], indistin-
    // guivel de "nao ha licitacao nesse recorte".
    expect(() => parseModalidadeList("Pregão")).toThrow(HttpError);
    expect(() => parseModalidadeList("pregao eletronico")).toThrow(HttpError);
  });

  it("rejeita mais de 5 valores", () => {
    expect(() => parseModalidadeList("a,b,c,d,e,f")).toThrow(HttpError);
  });
});

describe("parseLimit", () => {
  it("retorna 20 (default) quando raw e undefined", () => {
    expect(parseLimit(undefined)).toBe(20);
  });

  it("aceita inteiro dentro de 1-100", () => {
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("100")).toBe(100);
    expect(parseLimit("50")).toBe(50);
  });

  it("rejeita valor nao numerico ('abc' -> NaN)", () => {
    expect(() => parseLimit("abc")).toThrow(HttpError);
  });

  it("rejeita zero, negativo e acima de 100", () => {
    expect(() => parseLimit("0")).toThrow(HttpError);
    expect(() => parseLimit("-5")).toThrow(HttpError);
    expect(() => parseLimit("101")).toThrow(HttpError);
  });

  it("rejeita valor decimal (nao inteiro)", () => {
    expect(() => parseLimit("1.5")).toThrow(HttpError);
  });
});

describe("parseSort", () => {
  it("retorna 'desc' (default) quando raw e undefined", () => {
    expect(parseSort(undefined)).toBe("desc");
  });

  it("aceita 'asc' e 'desc'", () => {
    expect(parseSort("asc")).toBe("asc");
    expect(parseSort("desc")).toBe("desc");
  });

  it("rejeita qualquer outro valor", () => {
    expect(() => parseSort("ASC")).toThrow(HttpError);
    expect(() => parseSort("lixo")).toThrow(HttpError);
  });
});

describe("parseDateRange", () => {
  it("retorna objeto vazio quando nenhuma data e informada", () => {
    expect(parseDateRange(undefined, undefined)).toEqual({});
  });

  it("rejeita quando so uma das duas datas e informada (achado real corrigido)", () => {
    expect(() => parseDateRange("2026-01-01", undefined)).toThrow(HttpError);
    expect(() => parseDateRange(undefined, "2026-01-01")).toThrow(HttpError);
  });

  it("rejeita data invalida (nao parseavel)", () => {
    expect(() => parseDateRange("lixo", "2026-01-01")).toThrow(HttpError);
  });

  it("rejeita dataInicial posterior a dataFinal", () => {
    expect(() => parseDateRange("2026-06-01", "2026-01-01")).toThrow(HttpError);
  });

  it("aceita range valido", () => {
    expect(parseDateRange("2026-01-01", "2026-06-01")).toEqual({
      dataInicial: "2026-01-01",
      dataFinal: "2026-06-01",
    });
  });
});

describe("parseValorRange", () => {
  it("retorna campos undefined quando nada e informado", () => {
    expect(parseValorRange(undefined, undefined)).toEqual({ valorMin: undefined, valorMax: undefined });
  });

  it("rejeita valorMin nao numerico ou negativo", () => {
    expect(() => parseValorRange("abc", undefined)).toThrow(HttpError);
    expect(() => parseValorRange("-1", undefined)).toThrow(HttpError);
  });

  it("rejeita valorMax nao numerico ou negativo", () => {
    expect(() => parseValorRange(undefined, "abc")).toThrow(HttpError);
    expect(() => parseValorRange(undefined, "-1")).toThrow(HttpError);
  });

  it("rejeita valorMin > valorMax", () => {
    expect(() => parseValorRange("1000", "500")).toThrow(HttpError);
  });

  it("aceita range valido e converte pra numero", () => {
    expect(parseValorRange("100", "5000")).toEqual({ valorMin: 100, valorMax: 5000 });
  });

  it("aceita valorMin igual a valorMax", () => {
    expect(parseValorRange("100", "100")).toEqual({ valorMin: 100, valorMax: 100 });
  });
});

describe("assertValidWebhookUrl", () => {
  it("aceita URL http/https bem formada", () => {
    expect(() => assertValidWebhookUrl("https://exemplo.com/webhook")).not.toThrow();
    expect(() => assertValidWebhookUrl("http://exemplo.com/webhook")).not.toThrow();
  });

  it("rejeita string que nao e URL valida", () => {
    expect(() => assertValidWebhookUrl("nao-e-url")).toThrow(HttpError);
  });

  it("rejeita protocolo diferente de http/https (ex.: file://, ftp://)", () => {
    expect(() => assertValidWebhookUrl("ftp://exemplo.com")).toThrow(HttpError);
    expect(() => assertValidWebhookUrl("file:///etc/passwd")).toThrow(HttpError);
  });
});

describe("stableParamsKey", () => {
  it("gera a mesma chave independente da ordem das propriedades", () => {
    const a = stableParamsKey({ uf: "GO", limit: 10 });
    const b = stableParamsKey({ limit: 10, uf: "GO" });
    expect(a).toBe(b);
  });

  it("ignora propriedades com valor undefined", () => {
    const a = stableParamsKey({ uf: "GO", cursor: undefined });
    const b = stableParamsKey({ uf: "GO" });
    expect(a).toBe(b);
  });

  it("gera chaves diferentes para valores diferentes", () => {
    const a = stableParamsKey({ uf: "GO" });
    const b = stableParamsKey({ uf: "SP" });
    expect(a).not.toBe(b);
  });
});
