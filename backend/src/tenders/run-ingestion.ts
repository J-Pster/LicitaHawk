import { runIncrementalIngestion } from "./ingestion.service";
import { NoopTenderIngestedAdapter } from "../common/ports/noop-tender-ingested.adapter";

// Script standalone para rodar a ingestao incremental manualmente (fora do node-cron), usado pra
// verificacao da Fase 2 sem precisar esperar o agendamento de 15min.
runIncrementalIngestion(new NoopTenderIngestedAdapter())
  .then((result) => {
    console.log(`[run-ingestion] concluido: ${JSON.stringify(result)}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[run-ingestion] falhou", err);
    process.exit(1);
  });
