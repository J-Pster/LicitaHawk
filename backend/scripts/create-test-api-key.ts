import { createHash, randomBytes } from "crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../src/common/dynamodb-client";

// Utilitario de dev: cria uma API key de teste na tabela ApiKeys (DynamoDB Local) pra validar
// o middleware de autenticacao. Uso:
//   npx tsx scripts/create-test-api-key.ts [customer_id] [plan_tier] [asaas_customer_id]
// O 3o argumento e opcional -- so precisa quando for testar o fluxo de upgrade de plano via
// webhook do Asaas (customer-plan-sync.ts), que busca por esse campo via GSI-asaas-customer-id.
async function main() {
  const customerId = process.argv[2] ?? "test-customer-1";
  const planTier = process.argv[3] ?? "pro";
  const asaasCustomerId = process.argv[4];

  const rawKey = randomBytes(32).toString("hex");
  const apiKeyHash = createHash("sha256").update(rawKey).digest("hex");

  await ddbDocClient.send(
    new PutCommand({
      TableName: "ApiKeys",
      Item: {
        api_key_hash: apiKeyHash,
        customer_id: customerId,
        plan_tier: planTier,
        active: true,
        created_at: new Date().toISOString(),
        ...(asaasCustomerId ? { asaas_customer_id: asaasCustomerId } : {}),
      },
    }),
  );

  console.log(`API key de teste criada.`);
  console.log(`customer_id: ${customerId}`);
  console.log(`plan_tier: ${planTier}`);
  console.log(`raw key (usar em 'Authorization: Bearer <key>'): ${rawKey}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
