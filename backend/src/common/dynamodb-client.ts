import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { env } from "../config/env";

// DYNAMODB_ENDPOINT setado (local) -> aponta para o DynamoDB Local com credenciais fake.
// DYNAMODB_ENDPOINT ausente (producao) -> usa o endpoint real da AWS + credential chain padrao do SDK.
const client = new DynamoDBClient({
  region: env.awsRegion,
  ...(env.dynamodbEndpoint
    ? {
        endpoint: env.dynamodbEndpoint,
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      }
    : {}),
});

export const ddbDocClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
