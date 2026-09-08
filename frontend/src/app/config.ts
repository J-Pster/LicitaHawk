export const APP_CONFIG = {
  // Porta 3000 costuma estar ocupada por outro projeto (BidChex) nesta maquina -- licitahawk
  // roda em 3577 (dedicada) pra nao competir. Ver PLAN.md.
  apiUrl: 'http://localhost:3577',
  cognito: {
    userPoolId: 'us-east-1_VtOEPrPpu',
    clientId: '31jjvqf9e7g0ksglgnv5mt3utk',
    region: 'us-east-1',
  },
} as const;
