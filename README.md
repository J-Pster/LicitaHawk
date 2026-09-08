<p align="right">🇺🇸 English · <a href="./README.pt-BR.md">🇧🇷 Português</a></p>

# LicitaHawk

REST API + MCP server over the official public procurement (tender) data from Brazil's **PNCP** (Portal Nacional de Contratações Públicas), with webhook/email alerting, recurring subscription billing (Asaas), and service invoice issuance (Focus NFe). Monorepo: Express/TypeScript backend + Angular frontend.

## What it does

- **Continuous ingestion** of tenders published on the PNCP (scheduler + reconciliation), stored in DynamoDB.
- **Search API** with filters by state (UF), procurement modality, keyword, value, contracting body, municipality, and status, with deterministic pagination.
- **MCP server** exposing the same search capabilities as tools for AI agents.
- **Recurring alerts**: a user saves a filter and picks a delivery channel, webhook (HMAC-signed) or email, to be notified when a new tender matches the criteria.
- **Billing**: paid plans via Asaas (recurring subscription), with service invoice (nota fiscal) issuance through Focus NFe.
- **Angular frontend** with a dashboard, search screen, alerts, webhooks, usage, and account pages.

## Structure

```
backend/    Express 4 + TypeScript, DynamoDB, MCP server, ingestion scheduler, Asaas billing
frontend/   Angular (standalone, no NgRx), auth via Cognito
legal/      Terms of service and related documents
docs/       Project code quality standards
```

## Stack

**Backend:** Node.js + TypeScript, Express 4, DynamoDB (`@aws-sdk/lib-dynamodb`), Zod for boundary validation, Vitest, `@modelcontextprotocol/*` for the MCP server, `node-cron` for the ingestion scheduler, Cognito (`aws-jwt-verify`) for API auth.

**Frontend:** Angular standalone components (no NgRx, no Amplify), `amazon-cognito-identity-js` for auth directly against Cognito.

**Infra:** AWS (DynamoDB, Cognito, Route 53, SES/ZeptoMail), Asaas (billing), and Focus NFe (invoicing).

## Running locally

Prerequisites: Node.js 20+, Docker (for local DynamoDB).

### Backend

```bash
cd backend
cp .env.example .env   # fill in the variables, see the section below
docker compose up -d   # starts DynamoDB Local + dynamodb-admin (port 8001)
npm install
npm run dev             # API at http://localhost:3000
```

Other useful scripts inside `backend/`:

```bash
npm run typecheck              # tsc --noEmit
npm test                       # vitest run
npm run ingest                 # runs a manual PNCP ingestion
npm run reconcile              # reconciles already-ingested data
npm run create-test-key        # creates a test API key
```

### Frontend

```bash
cd frontend
npm install
npm start   # ng serve, http://localhost:4200
```

## Environment variables

All sensitive backend variables live in `backend/.env`, which is **never committed** (see `.gitignore`). `backend/.env.example` documents every one of them with comments explaining origin, expected format, and default behavior when absent, copy it to `.env` and fill it in before running the project. Section summary:

| Block | Purpose |
|-------|---------|
| Local environment | port, AWS region, local DynamoDB endpoint |
| Cognito | pool and client ID used to validate the frontend's JWT |
| Asaas | sandbox/production billing keys and webhook secret |
| Focus NFe | invoice-issuance tokens (production/staging) and webhook secrets |
| Prestador (issuer) | tax data for the CNPJ issuing the invoice (shared with another product under the same CNPJ) |
| Email | delivery provider (`EMAIL_PROVIDER`) and ZeptoMail credentials |

The frontend doesn't use `.env`: Cognito's public config (pool ID, client ID, not secrets) lives in Angular's environment files.

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE). Noncommercial use is free; commercial use requires a separate license granted by the author. See the **Noncommercial Purposes** and **Personal Uses** sections of the `LICENSE` file for what's already permitted by default.
