# LicitaHawk API -- Quickstart

Especificação completa: [`openapi.yaml`](./openapi.yaml).

## 1. Suba o ambiente local

```bash
docker compose up -d
bash scripts/create-tables.sh
npm run dev
```

## 2. Gere uma API key de teste

```bash
npm run create-test-key -- meu-customer-id pro
```

Guarde o `raw key` impresso -- ele não é recuperável depois (só o hash SHA-256 fica salvo em `ApiKeys`).

## 3. Chame a API

Toda rota exige autenticação via `Authorization: Bearer <key>` (ou `X-Api-Key: <key>`).

```bash
API_KEY="<raw key gerado no passo 2>"

# Buscar tenders por UF
curl -s "http://localhost:3000/v1/tenders?uf=GO&keyword=software" \
  -H "Authorization: Bearer $API_KEY"

# Buscar em várias UFs numa única chamada (até 5, separadas por vírgula) -- não suporta
# paginação via cursor nesse modo, ver Notas.
curl -s "http://localhost:3000/v1/tenders?uf=GO,SP,MG&limit=10" \
  -H "Authorization: Bearer $API_KEY"

# Filtrar por faixa de valor estimado e por data de publicação, ordenando do mais antigo pro
# mais novo
curl -s "http://localhost:3000/v1/tenders?uf=GO&valorMin=50000&valorMax=500000&dataInicial=2026-08-01T00:00:00&dataFinal=2026-09-06T23:59:59&sort=asc" \
  -H "Authorization: Bearer $API_KEY"

# Detalhe de um tender -- ATENCAO: pncp_control_number tem uma barra literal (ex.
# "07547821000191-1-000084/2026"), url-encode antes de montar a URL (barra -> %2F) ou o
# Express responde 404 "Cannot GET" (a barra crua vira separador de rota).
curl -s "http://localhost:3000/v1/tenders/07547821000191-1-000084%2F2026" \
  -H "Authorization: Bearer $API_KEY"

# Tenders de um órgão
curl -s "http://localhost:3000/v1/orgaos/<cnpj>/tenders" \
  -H "Authorization: Bearer $API_KEY"

# Criar um filtro salvo
curl -s -X POST "http://localhost:3000/v1/filters" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"uf":"GO","modalidade":"Pregão - Eletrônico","keyword":"software","webhook_url":"https://seu-servico.com/webhook"}'

# Listar meus filtros
curl -s "http://localhost:3000/v1/filters" -H "Authorization: Bearer $API_KEY"

# Apagar um filtro
curl -s -X DELETE "http://localhost:3000/v1/filters/<filter_id>" \
  -H "Authorization: Bearer $API_KEY"

# Histórico de entregas de webhook de um filtro
curl -s "http://localhost:3000/v1/filters/<filter_id>/deliveries" \
  -H "Authorization: Bearer $API_KEY"

# Status do serviço (sem autenticação) -- versão, uptime, conectividade com o DynamoDB
curl -s "http://localhost:3000/health"
```

## Notas

- `GET /v1/tenders` exige `uf` **ou** `modalidade` -- a API nunca faz `Scan` na tabela `Tenders`; sem um dos dois ela responde `400`. Ambos aceitam até 5 valores separados por vírgula (ex. `uf=GO,SP,MG`) para consultar múltiplas UFs/modalidades numa só chamada; nesse modo `next_cursor` não é retornado (pagine refinando o filtro, não com `cursor`).
- Filtros adicionais em `GET /v1/tenders` e `GET /v1/orgaos/{cnpj}/tenders`: `valorMin`/`valorMax` (faixa de `valor_estimado`), `dataInicial`+`dataFinal` (sempre os dois juntos, ISO 8601), `sort=asc|desc` (ordena por `data_publicacao`, padrão `desc`). `keyword` e a faixa de valor são aplicados em memória sobre a página vinda do índice, então `data.length` pode vir menor que `limit` mesmo havendo mais resultados adiante -- use `next_cursor` para continuar.
- Toda rota com `filter_id` só enxerga filtros do `customer_id` autenticado (proteção contra IDOR) -- pedir o filtro de outro customer responde `404`, nunca vaza dado de terceiro.
- **Dois limites distintos, não confundir:** limite MENSAL do plano (Free 100/mês, Starter 5.000/mês, Pro 50.000/mês, `code: PLAN_LIMIT_EXCEEDED`) e limite POR MINUTO contra rajada (Free 30/min, Starter 180/min, Pro 600/min, `code: RATE_LIMITED`, com header `Retry-After`). Os dois respondem `429`; os headers `X-RateLimit-Limit`/`X-RateLimit-Remaining` refletem sempre o limite por minuto.
- `GET /v1/tenders`, `GET /v1/tenders/{id}` e `GET /v1/orgaos/{cnpj}/tenders` têm cache de resposta de 30s, compartilhado entre clientes (dado de tender não é específico de customer). O header `X-Cache: HIT|MISS` indica se veio do cache.
- Toda resposta de erro segue `{ "error": { "code": "...", "message": "..." } }` -- prefira tratar por `code` (ex.: `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `RATE_LIMITED`, `PLAN_LIMIT_EXCEEDED`) em vez de parsear `message`, que é em português e pode mudar.
- `uf` é validada contra a lista de 27 siglas; `webhook_url` precisa ser uma URL `http(s)` bem formada -- os dois são checados na criação do filtro (`POST /v1/filters`), antes de qualquer tentativa de disparo.
