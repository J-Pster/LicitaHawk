export type PlanTier = "free" | "starter" | "pro";

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  priceBrl: number;
  requestsPerMonth: number;
  // Infinity = sem limite (representado como null quando serializado para API/JSON).
  maxFilters: number;
  webhooksEnabled: boolean;
}

export const PLANS: Record<PlanTier, PlanDefinition> = {
  free: {
    tier: "free",
    name: "Free",
    priceBrl: 0,
    requestsPerMonth: 100,
    maxFilters: 0,
    webhooksEnabled: false,
  },
  starter: {
    tier: "starter",
    name: "Starter",
    priceBrl: 49,
    requestsPerMonth: 5000,
    maxFilters: 3,
    webhooksEnabled: true,
  },
  pro: {
    tier: "pro",
    name: "Pro",
    priceBrl: 149,
    requestsPerMonth: 50000,
    maxFilters: Infinity,
    webhooksEnabled: true,
  },
};

/**
 * Mapeia o valor de uma cobranca Asaas de volta pro plano correspondente.
 * Usado pelo webhook de pagamento confirmado para saber qual plano ativar.
 */
export function planByPriceBrl(value: number): PlanDefinition | undefined {
  return Object.values(PLANS).find((plan) => plan.priceBrl === value);
}
