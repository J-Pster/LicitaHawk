/**
 * Alerta operacional estruturado (item #4 das sugestoes do PLAN.md: hoje falha de
 * circuit-breaker/NF-e so vira console.log solto, dificil de filtrar/alarmar). Emite uma unica
 * linha JSON em stderr com um `event` estavel + `severity` -- formato pronto pra virar um
 * CloudWatch Metric Filter/Alarm na Fase 7 (ou SES real, backlog #4) sem precisar tocar no
 * chamador de novo. Nunca lanca -- observabilidade nao pode derrubar o fluxo real.
 */
export type OpsAlertSeverity = "warning" | "critical";

export interface OpsAlertContext {
  [key: string]: unknown;
}

export function opsAlert(event: string, severity: OpsAlertSeverity, context: OpsAlertContext = {}): void {
  try {
    const line = {
      ops_alert: true,
      severity,
      event,
      timestamp: new Date().toISOString(),
      ...context,
    };
    console.error(`[ops-alert] ${JSON.stringify(line)}`);
  } catch {
    // Nunca deixar um erro de serializacao (ex.: referencia circular no contexto) derrubar o
    // caminho real que estava tentando alertar sobre uma falha.
  }
}
