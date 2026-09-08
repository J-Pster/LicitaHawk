import { runReconciliation } from "./reconciliation.service";
import { NoopTenderIngestedAdapter } from "../common/ports/noop-tender-ingested.adapter";

// Script standalone para rodar a reconciliacao manualmente, usado pra verificacao da Fase 2.
runReconciliation(new NoopTenderIngestedAdapter())
  .then((result) => {
    console.log(`[run-reconciliation] concluido: ${JSON.stringify(result)}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[run-reconciliation] falhou", err);
    process.exit(1);
  });
