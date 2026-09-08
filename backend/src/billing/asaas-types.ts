/**
 * Payload de webhook do Asaas para eventos de pagamento (evento "PAYMENT_*").
 * Campos padrao confirmados na doc oficial (docs.asaas.com/docs/sobre-os-webhooks):
 * event, payment.id, payment.customer (so o ID, nao o cadastro completo),
 * payment.value, payment.billingType, payment.status.
 *
 * customerName/customerCpfCnpj/customerEmail NAO sao campos padrao do Asaas --
 * o Asaas so manda o ID do customer no payload de pagamento. Em producao, o
 * dado do tomador (razao social/CPF-CNPJ) precisa vir de um lookup real via
 * GET /v3/customers/{id} ou de uma tabela Customers propria do LicitaHawk, que
 * ainda nao existe nesta fase (ver decisao no relatorio do worker). Esses
 * campos extras existem so pra permitir montar o payload completo da NFS-e
 * end-to-end no MVP atual, sem bloquear a Fase 5 numa dependencia de uma
 * tabela que e responsabilidade de outra fase.
 */
export interface AsaasPaymentWebhookPayload {
  id: string;
  customer: string;
  subscription?: string;
  value: number;
  billingType?: string;
  status?: string;
  customerName?: string;
  customerCpfCnpj?: string;
  customerEmail?: string;
}

export interface AsaasWebhookBody {
  event?: string;
  payment?: AsaasPaymentWebhookPayload;
}
