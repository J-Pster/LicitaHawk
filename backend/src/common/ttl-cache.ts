// Cache em memoria de processo com TTL, tamanho maximo (eviction FIFO simples quando cheio).
// Usado pra reduzir carga no DynamoDB em queries populares/repetidas (ex.: GET /v1/tenders com
// os mesmos filtros, chamado por varios clientes ou pelo mesmo cliente em rajada).
//
// Limitacao honesta: e' cache LOCAL ao processo. Em Lambda (Fase 7), cada instancia fria tem seu
// proprio cache vazio -- nao e' um cache compartilhado tipo Redis/ElastiCache. Ainda assim reduz
// carga real: (1) hoje, no processo local de vida longa, que e' o unico ambiente ate a Fase 7;
// (2) em producao, dentro da janela de vida de uma instancia Lambda quente que recebe requests
// repetidos. Migrar para um cache compartilhado real e' candidato a melhoria futura se o volume
// justificar (mesmo criterio ja usado para a decisao de OpenSearch em ~500k tenders).
export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number = 500,
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
