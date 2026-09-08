import { Tender } from "../../tenders/tender.types";

// Local: implementacao chama o matcher direto em processo (mesmo request). Producao: no-op -- quem dispara o matcher de verdade e o DynamoDB Stream (ver ADR no PLAN.md).
export interface TenderIngestedPort {
  emit(tender: Tender): Promise<void>;
}
