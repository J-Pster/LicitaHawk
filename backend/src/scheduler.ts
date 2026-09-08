import cron from "node-cron";
import { runIncrementalIngestion } from "./tenders/ingestion.service";
import { runReconciliation } from "./tenders/reconciliation.service";
import { tenderMatcher } from "./webhook/tender-matcher.instance";
import { reconcilePlanTiers } from "./billing/reconciliation.service";

// Integracao final (team-lead): adapter NO-OP da Fase 1/2 trocado pelo matcher real da Fase 4 --
// agora todo tender novo/atualizado gravado pelo poller dispara a checagem de filtros salvos de
// verdade (Query na GSI uf+modalidade, nunca Scan) e enfileira webhook quando bate.
const tenderIngestedPort = tenderMatcher;

/**
 * So roda enquanto o processo local (node-cron) esta de pe. Em producao (Fase 7) os mesmos jobs
 * sao invocados por EventBridge Scheduler chamando a funcao equivalente como Lambda, nao por isso.
 */
// Achado real da Rodada 6 (verificacao/testes): node-cron NAO espera a execucao anterior terminar
// antes de disparar a proxima -- se runIncrementalIngestion (a cada 15min) ou runReconciliation
// (janela de 30 dias, muito mais lenta) demorar mais que o proprio intervalo do cron (plausivel sob
// instabilidade do PNCP, mesmo com o timeout de fetch da Rodada 6 em pncp-client.ts), duas execucoes
// rodam em paralelo. Isso dobra a taxa efetiva de requests contra o PNCP (violando o 1 req/s
// pretendido, ver Notas de Execucao #1 do PLAN.md) e causa corrida de leitura-entao-escrita no
// estado global de RateLimitMetrics (rate-limit-tracking.ts). As duas jobs competem pelo mesmo
// recurso (API do PNCP) e pelo mesmo estado global, entao compartilham uma unica trava.
let ingestionJobRunning = false;

async function runExclusive(jobName: string, job: () => Promise<{ fetched: number; written: number; failedModalidades: number[] }>): Promise<void> {
  if (ingestionJobRunning) {
    console.warn(`[scheduler] ${jobName} pulada -- outra execucao de ingestao/reconciliacao ja em andamento`);
    return;
  }
  ingestionJobRunning = true;
  try {
    const result = await job();
    console.log(`[scheduler] ${jobName}: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`[scheduler] falha em ${jobName}`, err);
  } finally {
    ingestionJobRunning = false;
  }
}

export function startScheduler(): void {
  cron.schedule("*/15 * * * *", () => runExclusive("ingestao incremental", () => runIncrementalIngestion(tenderIngestedPort)));

  // Reconciliacao semanal: domingo as 03:00.
  cron.schedule("0 3 * * 0", () => runExclusive("reconciliacao semanal", () => runReconciliation(tenderIngestedPort)));

  // Reconciliacao de plan_tier via Asaas real (Rodada 4, Risco #13 do PLAN.md): a cada 30min,
  // suficientemente frequente pra fechar um gap de webhook nao entregue em tempo razoavel, sem
  // martelar a API real do Asaas (janela de LOOKBACK_DAYS=3 no proprio job da folga contra
  // execucoes perdidas).
  cron.schedule("*/30 * * * *", async () => {
    try {
      const result = await reconcilePlanTiers();
      console.log(`[scheduler] reconciliacao de billing: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error("[scheduler] falha na reconciliacao de billing", err);
    }
  });

  console.log("[scheduler] jobs registrados (ingestao a cada 15min, reconciliacao semanal de tenders, reconciliacao de billing a cada 30min)");
}
