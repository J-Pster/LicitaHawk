import { TenderIngestedPort } from "./tender-ingested-port";
import { Tender } from "../../tenders/tender.types";

// Adapter temporario da Fase 1/2 -- so existe pra nao quebrar a chamada do job de ingestao antes da Fase 4 implementar o matcher de verdade.
export class NoopTenderIngestedAdapter implements TenderIngestedPort {
  async emit(_tender: Tender): Promise<void> {
    // intencionalmente vazio
  }
}
