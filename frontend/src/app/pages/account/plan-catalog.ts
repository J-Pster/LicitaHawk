export type PlanTier = 'free' | 'starter' | 'pro';

export interface PlanCatalogEntry {
  tier: PlanTier;
  name: string;
  priceLabel: string;
  requestsPerMonth: number;
  requestsPerMinute: number;
  features: string[];
}

/**
 * Catálogo estático dos três planos. Não existe endpoint que devolva os limites dos planos que
 * não são o atual (getUsage só traz o plano ativo da conta), então os valores ficam fixos aqui --
 * espelham backend/src/billing/plans.ts (preço, limite mensal) e
 * backend/src/common/client-rate-limit.ts (limite por minuto). Se o backend mudar esses números,
 * este arquivo precisa acompanhar. `pages/api-docs/` também tem esses mesmos limites hardcoded
 * (tabela de limites da documentação) -- atualize os dois juntos.
 */
export const PLAN_CATALOG: readonly PlanCatalogEntry[] = [
  {
    tier: 'free',
    name: 'Free',
    priceLabel: 'Grátis',
    requestsPerMonth: 100,
    requestsPerMinute: 30,
    features: ['Busca de licitações via API e MCP', 'Sem filtros salvos com alerta por webhook'],
  },
  {
    tier: 'starter',
    name: 'Starter',
    priceLabel: 'R$ 49/mês',
    requestsPerMonth: 5000,
    requestsPerMinute: 180,
    features: ['Tudo do plano Free', 'Até 3 filtros salvos com alerta por webhook', 'Suporte por email'],
  },
  {
    tier: 'pro',
    name: 'Pro',
    priceLabel: 'R$ 149/mês',
    requestsPerMonth: 50000,
    requestsPerMinute: 600,
    features: ['Tudo do plano Starter', 'Filtros salvos ilimitados', 'Suporte prioritário'],
  },
];

const TIER_ORDER: Record<PlanTier, number> = { free: 0, starter: 1, pro: 2 };

export function planEntry(tier: PlanTier): PlanCatalogEntry {
  return PLAN_CATALOG.find((p) => p.tier === tier) ?? PLAN_CATALOG[0];
}

/** True quando `target` representa um degrau acima de `current` (nunca lateral ou abaixo). */
export function isUpgradeFrom(current: PlanTier, target: PlanTier): boolean {
  return TIER_ORDER[target] > TIER_ORDER[current];
}

/** True só quando `target` é o próximo degrau logo acima de `current` -- usado pra decidir qual
 * botão de upgrade é o dourado (ação primária única por tela); os demais upgrades usam contorno. */
export function isNextTierAbove(current: PlanTier, target: PlanTier): boolean {
  return TIER_ORDER[target] === TIER_ORDER[current] + 1;
}
