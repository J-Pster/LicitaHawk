<p align="right"><a href="./README.md">🇺🇸 English</a> · 🇧🇷 Português</p>

# LicitaHawk

API REST + servidor MCP sobre os dados oficiais de licitações públicas do **PNCP** (Portal Nacional de Contratações Públicas, Brasil), com alerta por webhook/email, assinatura recorrente (Asaas) e nota fiscal de serviço (Focus NFe). Monorepo backend (Express/TypeScript) + frontend (Angular).

## O que o produto faz

- **Ingestão contínua** dos editais publicados no PNCP (scheduler + reconciliação), gravados em DynamoDB.
- **API de busca** com filtros por UF, modalidade, palavra-chave, valor, órgão, município e situação, com paginação determinística.
- **Servidor MCP** que expõe as mesmas buscas como ferramentas para agentes de IA.
- **Alertas recorrentes**: o usuário salva um filtro e escolhe um canal de entrega, webhook (com assinatura HMAC) ou email, para ser notificado quando uma licitação nova casar com o critério.
- **Billing**: planos pagos via Asaas (assinatura recorrente), com emissão de nota fiscal de serviço via Focus NFe.
- **Frontend Angular** com dashboard, tela de busca, alertas, webhooks, uso e conta.

## Estrutura

```
backend/    Express 4 + TypeScript, DynamoDB, servidor MCP, scheduler de ingestão, billing Asaas
frontend/   Angular (standalone, sem NgRx), auth via Cognito
legal/      Termos de serviço e afins
docs/       Padrões de qualidade de código do projeto
```

## Stack

**Backend:** Node.js + TypeScript, Express 4, DynamoDB (`@aws-sdk/lib-dynamodb`), Zod para validação de boundary, Vitest, `@modelcontextprotocol/*` para o servidor MCP, `node-cron` para o scheduler de ingestão, Cognito (`aws-jwt-verify`) para auth de API.

**Frontend:** Angular standalone components (sem NgRx, sem Amplify), `amazon-cognito-identity-js` para auth direto contra o Cognito.

**Infra:** AWS (DynamoDB, Cognito, Route 53, SES/ZeptoMail), Asaas (billing) e Focus NFe (nota fiscal).

## Rodando localmente

Pré-requisitos: Node.js 20+, Docker (para o DynamoDB local).

### Backend

```bash
cd backend
cp .env.example .env   # preencha as variáveis, veja a seção abaixo
docker compose up -d   # sobe DynamoDB Local + dynamodb-admin (porta 8001)
npm install
npm run dev             # API em http://localhost:3000
```

Outros scripts úteis dentro de `backend/`:

```bash
npm run typecheck              # tsc --noEmit
npm test                       # vitest run
npm run ingest                 # roda uma ingestão manual do PNCP
npm run reconcile              # reconciliação de dados já ingeridos
npm run create-test-key        # cria uma API key de teste
```

### Frontend

```bash
cd frontend
npm install
npm start   # ng serve, http://localhost:4200
```

## Variáveis de ambiente

Todas as variáveis sensíveis do backend ficam em `backend/.env`, que **nunca é versionado** (veja `.gitignore`). O arquivo `backend/.env.example` documenta cada uma delas com comentários explicando origem, formato esperado e comportamento default quando ausente, copie-o para `.env` e preencha antes de rodar o projeto. Resumo das seções:

| Bloco | Para que serve |
|-------|-----------------|
| Ambiente local | porta, região AWS, endpoint do DynamoDB local |
| Cognito | pool e client ID usados para validar o JWT do frontend |
| Asaas | chaves de sandbox/produção do billing e segredo do webhook |
| Focus NFe | tokens de emissão de nota fiscal (produção/homologação) e segredo dos webhooks |
| Prestador | dados fiscais do CNPJ emissor da nota (compartilhado com outro produto do mesmo CNPJ) |
| Email | provedor de envio (`EMAIL_PROVIDER`) e credenciais do ZeptoMail |

O frontend não usa `.env`: a configuração pública do Cognito (pool ID, client ID, não são segredos) vive nos arquivos de ambiente do Angular.

## Licença

[PolyForm Noncommercial License 1.0.0](./LICENSE). Uso não comercial é livre; uso comercial requer licença separada concedida pelo autor. Veja as seções **Noncommercial Purposes** e **Personal Uses** do arquivo `LICENSE` para o que já está liberado por padrão.
