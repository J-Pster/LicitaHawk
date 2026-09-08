import { LocalTenderMatcherAdapter } from "./tender-matcher.adapter";
import { alertQueue } from "./alert-queue.instance";

// Exportado pra o team-lead trocar o NoopTenderIngestedAdapter por este em src/scheduler.ts
// (Fase 4 nao edita scheduler.ts nem server.ts, ver regra de fronteira do time).
export const tenderMatcher = new LocalTenderMatcherAdapter(alertQueue);
