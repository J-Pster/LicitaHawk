import "dotenv/config";

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  dynamodbEndpoint: process.env.DYNAMODB_ENDPOINT || undefined,
  cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
  cognitoClientId: process.env.COGNITO_CLIENT_ID ?? "",
  cognitoRegion: process.env.COGNITO_REGION ?? "us-east-1",
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:4200",
  // Email: default "console" (nao envia, so loga) e' o equivalente do default sandbox do Asaas --
  // rodar a API local sem configurar nada nunca dispara email de verdade. Nome fora da lista do
  // connector-registry derruba o boot. O token do provider e' lido no proprio connector.
  emailProvider: process.env.EMAIL_PROVIDER ?? "console",
  emailFromAddress: process.env.EMAIL_FROM_ADDRESS ?? "noreply@licitahawk.com",
  emailFromName: process.env.EMAIL_FROM_NAME ?? "LicitaHawk",
};
