// Local: implementacao usa fila em memoria no mesmo processo. Producao: SQS real (ver ADR no PLAN.md).
//
// Um job carrega o alvo ja resolvido (`target`): quem monta o job (matcher / endpoint de teste)
// ja tem o SavedFilter completo em maos, entao nao vale uma leitura extra ao DynamoDB no momento
// do disparo. A excecao e' o canal email, cujo destinatario NAO viaja no job -- e' o email da
// conta, resolvido no envio, pra nunca despachar para um endereco que o usuario ja trocou.

export type AlertDeliveryTarget =
  | { channel: "webhook"; url: string; secret: string }
  | { channel: "email" };

/** Payload de `tender.matched` -- o mesmo corpo que o webhook posta e que o email renderiza. */
export interface TenderMatchedPayload {
  event: "tender.matched";
  filter_id: string;
  test?: boolean;
  tender: {
    pncp_control_number: string;
    org_cnpj: string;
    org_name: string;
    uf: string;
    modalidade: string;
    objeto: string;
    valor_estimado: number | null;
    link_pncp: string;
  };
}

export interface AlertDeliveryJob {
  filter_id: string;
  customer_id: string;
  payload: TenderMatchedPayload;
  attempt: number;
  idempotencyKey: string;
  target: AlertDeliveryTarget;
}

export interface AlertQueuePort {
  enqueue(job: AlertDeliveryJob): Promise<void>;
}
