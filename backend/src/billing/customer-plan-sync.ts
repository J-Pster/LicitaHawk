import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../common/dynamodb-client";
import { PlanTier } from "../common/auth/types";
import { opsAlert } from "../common/ops-alert";

const API_KEYS_TABLE = "ApiKeys";
const GSI_NAME = "GSI-asaas-customer-id";

/**
 * Achado real da revisao de qualidade pos-implementacao: o webhook de pagamento do Asaas
 * emitia a nota fiscal corretamente, mas NUNCA atualizava o plan_tier real do ApiKeyRecord --
 * um cliente pagava, a nota saia certinho, e o limite de requisicao (api-key.middleware.ts)
 * continuava travado no plano antigo pra sempre.
 *
 * Requisito para isso funcionar: o ApiKeyRecord do cliente precisa ter o campo
 * `asaas_customer_id` preenchido (linkando o customer do Asaas ao customer_id/api_key_hash do
 * LicitaHawk). Essa vinculacao ainda nao tem um fluxo de cadastro real no MVP (hoje a API key de
 * teste e' criada via script de dev, sem passar pelo Asaas) -- ver PLAN.md, item de melhoria
 * futura "fluxo de signup real". Enquanto isso nao existir, a funcao abaixo faz o que pode: se
 * achar o ApiKeyRecord correspondente, atualiza; se nao achar, loga um aviso claro (nao falha
 * silenciosamente) para ficar visivel que a vinculacao esta faltando pra aquele cliente.
 */
export interface PlanSyncResult {
  updatedCount: number;
  customerId?: string;
  previousTier?: PlanTier;
}

/**
 * Ponto unico que troca o plan_tier real de um cliente a partir do asaas_customer_id (via
 * GSI-asaas-customer-id em ApiKeys). Generalizado nesta rodada (antes so existia
 * `upgradePlanForAsaasCustomer`, sempre pra cima) porque o webhook do Asaas tambem precisa
 * REBAIXAR o plano em eventos de reversao financeira (estorno/chargeback/cobranca deletada --
 * ver asaas-webhook.router.ts) -- sem isso, um cliente que teve o pagamento estornado continuava
 * com acesso Pro/Starter pra sempre, um bug real de negocio (perda de receita), nao so uma
 * lacuna de UX. `previousTier` no retorno alimenta o log/alerta de quem chamou (ex.: severidade
 * diferente pra "upgrade" vs "downgrade por estorno").
 *
 * Bug real corrigido (multiplas chaves por cliente, src/account/api-keys.service.ts): a Query na
 * GSI so atualizava `res.Items?.[0]` -- o PRIMEIRO item que a GSI devolvesse, sem filtrar por
 * `active`. Com um cliente podendo ter varias `ApiKeys` (multiplas chaves nomeadas, todas com o
 * mesmo `asaas_customer_id`), um upgrade/downgrade de plano so atualizava UMA chave, deixando as
 * demais autenticando com `plan_tier` desatualizado pra sempre (`authenticate`,
 * api-key.middleware.ts, le `plan_tier` direto da linha da chave usada na requisicao). Corrigido:
 * Query sem `Limit`, filtra `active` em memoria (mesmo padrao ja usado em
 * account.repository.ts::findAccountByCustomerId), itera e faz um `UpdateCommand` em CADA linha
 * ativa cujo tier ainda nao bate com o novo.
 */
export async function setPlanTierForAsaasCustomer(
  asaasCustomerId: string,
  planTier: PlanTier,
): Promise<PlanSyncResult> {
  const res = await ddbDocClient.send(
    new QueryCommand({
      TableName: API_KEYS_TABLE,
      IndexName: GSI_NAME,
      KeyConditionExpression: "asaas_customer_id = :cid",
      ExpressionAttributeValues: { ":cid": asaasCustomerId },
    }),
  );

  const items = res.Items ?? [];
  const activeItems = items.filter((item) => item.active !== false);

  if (activeItems.length === 0) {
    console.warn(
      `[billing] evento de pagamento pro asaas_customer_id=${asaasCustomerId}, mas nenhuma ApiKeyRecord ATIVA vinculada -- plan_tier NAO atualizado (fluxo de signup/vinculacao ainda nao existe, ou todas as chaves do cliente ja foram revogadas)`,
    );
    return { updatedCount: 0, customerId: items[0]?.customer_id };
  }

  const customerId = activeItems[0].customer_id as string;
  const previousTier = activeItems[0].plan_tier as PlanTier | undefined;
  const toUpdate = activeItems.filter((item) => item.plan_tier !== planTier);

  if (toUpdate.length === 0) {
    // Idempotente: reconciliacao/webhook duplicado batendo no mesmo estado ja atual (em TODAS
    // as chaves ativas) nao precisa de UpdateItem nem log novo.
    return { updatedCount: 0, customerId, previousTier };
  }

  await Promise.all(
    toUpdate.map((item) =>
      ddbDocClient.send(
        new UpdateCommand({
          TableName: API_KEYS_TABLE,
          Key: { api_key_hash: item.api_key_hash },
          UpdateExpression: "SET plan_tier = :tier",
          ExpressionAttributeValues: { ":tier": planTier },
        }),
      ),
    ),
  );
  console.log(
    `[billing] plan_tier atualizado de '${previousTier ?? "?"}' para '${planTier}' em ${toUpdate.length} chave(s) | customer_id=${customerId} asaas_customer_id=${asaasCustomerId}`,
  );
  return { updatedCount: toUpdate.length, customerId, previousTier };
}

/** Wrapper fino mantido pro chamador original (invoice-emitter.ts, pagamento confirmado). */
export async function upgradePlanForAsaasCustomer(asaasCustomerId: string, planTier: PlanTier): Promise<boolean> {
  const result = await setPlanTierForAsaasCustomer(asaasCustomerId, planTier);
  return result.updatedCount > 0;
}

/**
 * Rebaixa o cliente pro plano Free em resposta a uma reversao financeira confirmada (estorno,
 * chargeback, cobranca deletada). Emite opsAlert critical -- e' um evento de perda de receita
 * ativo, merece visibilidade operacional imediata, nao so um log solto.
 */
export async function downgradeToFreeForAsaasCustomer(
  asaasCustomerId: string,
  reason: string,
): Promise<PlanSyncResult> {
  const result = await setPlanTierForAsaasCustomer(asaasCustomerId, "free");
  if (result.updatedCount > 0) {
    opsAlert("billing_plan_downgraded", "critical", {
      asaas_customer_id: asaasCustomerId,
      customer_id: result.customerId,
      previous_tier: result.previousTier,
      reason,
    });
  }
  return result;
}
