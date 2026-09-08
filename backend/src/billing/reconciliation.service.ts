import { AsaasApiError, getPaymentById, listPaymentsByStatusSince } from "./asaas-client";
import { setPlanTierForAsaasCustomer } from "./customer-plan-sync";
import { planByPriceBrl } from "./plans";
import { opsAlert } from "../common/ops-alert";

// Janela de reconciliacao: cobre bem mais que o intervalo entre execucoes (30min, ver
// scheduler.ts) de proposito -- reprocessar pagamentos ja sincronizados e' barato (
// setPlanTierForAsaasCustomer e' idempotente, so escreve se o tier mudou) e da margem pra um
// gap maior (processo fora do ar por horas, deploy, etc.) sem perder reconciliacao.
const LOOKBACK_DAYS = 3;
// Eventos de pagamento confirmado tratados pelo webhook em tempo real (ver
// asaas-webhook.router.ts) -- a reconciliacao cobre exatamente os MESMOS status, pra fechar o
// Risco #13 do PLAN.md ("webhook do Asaas nao entregue -> plan_tier desatualizado"), sem
// duplicar logica de mapeamento de evento->status.
const RECONCILE_STATUSES = ["CONFIRMED", "RECEIVED"];

function isoDateNDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface ReconciliationResult {
  checked: number;
  driftFound: number;
  driftFixed: number;
  errors: number;
}

/**
 * Job de reconciliacao periodica (Rodada 4, Risco #13 do PLAN.md): consulta a API REAL do Asaas
 * por pagamentos confirmados/recebidos recentes e garante que plan_tier local reflete isso,
 * mesmo se o webhook original nunca tiver chegado (rede, processo fora do ar no momento exato,
 * etc.). Escopo deliberadamente limitado a SINCRONIZAR plan_tier -- nao reemite NF-e (isso ja
 * aconteceu via webhook se o pagamento foi processado por ele; reemitir aqui arriscaria nota
 * fiscal duplicada pro mesmo pagamento) e nao cobre reversao financeira (estorno/chargeback --
 * esses ja sao tratados em tempo real no webhook, ver REVOKE_ACCESS_EVENTS; adicionar isso aqui
 * tambem exigiria decidir uma janela de "confianca" que hoje nao existe, avaliado e adiado).
 * Nunca lanca pro chamador (scheduler.ts) -- falha de reconciliacao nao pode virar crash de
 * processo, mesma politica de todo job de background do projeto.
 */
export async function reconcilePlanTiers(): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { checked: 0, driftFound: 0, driftFixed: 0, errors: 0 };
  const since = isoDateNDaysAgo(LOOKBACK_DAYS);

  for (const status of RECONCILE_STATUSES) {
    let payments;
    try {
      payments = await listPaymentsByStatusSince(status, since);
    } catch (err) {
      result.errors++;
      const detail = err instanceof AsaasApiError ? `HTTP ${err.status}` : (err as Error).message;
      opsAlert("billing_reconciliation_fetch_failed", "warning", { status, error: detail });
      continue;
    }

    for (const payment of payments) {
      result.checked++;
      const plan = planByPriceBrl(payment.value);
      if (!plan) {
        // Valor nao corresponde a nenhum plano conhecido (ex.: cobranca avulsa fora dos planos
        // Free/Starter/Pro) -- fora do escopo da reconciliacao de plan_tier, ignorado.
        continue;
      }
      try {
        // Achado real da Rodada 9 (race de escrita em plan_tier): `payments` e' um snapshot da
        // listagem paginada no INICIO desta execucao, que pode levar segundos a minutos pra
        // esgotar. Se um estorno/chargeback chegar via webhook nesse meio-tempo pro MESMO
        // pagamento (downgradeToFreeForAsaasCustomer ja rodou), escrever o tier aqui com o dado
        // do snapshot desatualizado reverteria silenciosamente o downgrade legitimo -- exatamente
        // o bug de negocio que a Rodada 4 corrigiu, so que por um segundo caminho. Releitura
        // pontual (1 GET por pagamento, aceitavel: job roda a cada 30min, nao e' hot path) garante
        // que so escrevemos com base no status MAIS RECENTE, imediatamente antes do write.
        const fresh = await getPaymentById(payment.id);
        if (!RECONCILE_STATUSES.includes(fresh.status)) {
          console.warn(
            `[billing-reconciliation] pagamento ${payment.id} mudou de status (${status} -> ${fresh.status}) desde a listagem, pulando pra nao reverter um downgrade mais recente`,
          );
          continue;
        }
        const sync = await setPlanTierForAsaasCustomer(payment.customer, plan.tier);
        if (sync.updatedCount > 0) {
          result.driftFound++;
          result.driftFixed++;
          opsAlert("billing_reconciliation_drift_fixed", "warning", {
            asaas_customer_id: payment.customer,
            asaas_payment_id: payment.id,
            previous_tier: sync.previousTier,
            corrected_tier: plan.tier,
          });
        }
      } catch (err) {
        result.errors++;
        opsAlert("billing_reconciliation_sync_failed", "warning", {
          asaas_customer_id: payment.customer,
          asaas_payment_id: payment.id,
          error: (err as Error).message,
        });
      }
    }
  }

  return result;
}
