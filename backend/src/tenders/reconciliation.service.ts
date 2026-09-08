import { TenderIngestedPort } from "../common/ports/tender-ingested-port";
import { ingestWindow, formatYYYYMMDD, IngestResult } from "./ingestion.service";

const WINDOW_DAYS = 30;

/**
 * Job de reconciliacao semanal (Fase 2.4): full scan de janela de 30 dias, ignora o checkpoint
 * incremental. Cobre itens que o poller incremental possa ter perdido (ex.: republicacao tardia,
 * instabilidade momentanea do PNCP).
 */
export async function runReconciliation(port: TenderIngestedPort): Promise<IngestResult> {
  const today = new Date();
  const windowStart = new Date(today.getTime() - WINDOW_DAYS * 24 * 3600 * 1000);

  const dataInicial = formatYYYYMMDD(windowStart);
  const dataFinal = formatYYYYMMDD(today);

  return ingestWindow(dataInicial, dataFinal, port);
}
