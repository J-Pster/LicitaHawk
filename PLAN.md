# LicitaHawk — Plano de MVP

## Status Atual (ledger de execução — LEIA ISTO PRIMEIRO se você é uma IA nova continuando este trabalho)

### 🆕 Alertas por email viram um canal de verdade (e Webhooks ganha CRUD próprio) (2026-09-08)

A tela de Alertas era a tela de Webhooks com outro nome: os dois liam o mesmo `SavedFilter`, que
exigia `webhook_url`. Agora um filtro salvo é **um critério mais UM canal de entrega**.

- **Canal como união discriminada.** `SavedFilter` virou `SavedWebhookFilter | SavedEmailFilter`
  (`channel` + os campos que só existem naquele canal). Filtro de email não tem `webhook_url` nem
  `webhook_secret`, e o compilador cobra a decisão em cada ponto de uso. `parseSavedFilter` é a
  única fronteira de leitura do DynamoDB: item gravado antes do canal existir não tem `channel` e é
  webhook por definição.
- **Uma fila para os dois canais.** `WebhookQueuePort`/`WebhookDeliveryJob` viraram
  `AlertQueuePort`/`AlertDeliveryJob`, com um `target` que é `{webhook, url, secret}` ou `{email}`.
  Retry, backoff, circuit breaker e log de entregas são política de entrega, não detalhe de
  transporte: duplicar por canal seria garantir que os dois divergem na primeira correção de bug.
  `toDeliveryTarget` é o único lugar que traduz canal em alvo, com `switch` exaustivo, então um
  canal novo não pode ser esquecido no matcher, no disparo de teste ou na recuperação pós-restart.
- **O destinatário nunca é guardado nem aceito do cliente.** É o email da conta, resolvido na hora
  do envio. Guardar cópia criaria um endereço que envelhece em silêncio; aceitar endereço arbitrário
  transformaria o domínio verificado num relay de email para terceiros.
- **A fila durável parou de gravar `url`.** Já era campo morto: a recuperação relê o `SavedFilter` e
  remonta o alvo. Tirar isso fez o canal email caber sem campo novo.
- **Novo balde de uso `email_count`.** Contar alerta por email como uso de webhook mentiria no
  relatório do cliente. Propagado até o gráfico diário e o donut da tela de Uso.
- **`/v1/account/alerts`** espelha `/v1/account/webhooks` para o canal email, mais
  `POST /:id/copy-to-webhook` (o "Copiar para um webhook": os critérios saem do alerta guardado,
  nunca do request, e o webhook criado é independente). Id de uma coleção não existe na outra: 404.
  As regras compartilhadas (plano, teto, validação de critério) moram em `filter-routes.common.ts`.
- **Email renderiza o MESMO payload que o webhook posta** (`tender-matched.email.ts`), então os dois
  canais não divergem no conteúdo. Todo texto vindo do PNCP passa por escape, e `link_pncp` só vira
  href se for http(s).
- **Buraco real fechado: a tela de Webhooks ganhou CRUD.** Ela delegava criar/editar/excluir para a
  tela de Alertas; com Alertas virando email, ninguém mais conseguiria criar um webhook.
- **Testado ao vivo** contra o DynamoDB local: o matcher casou o alerta, resolveu o email da conta,
  gravou entrega com `channel: "email"` e `status_code: null` e incrementou `email_count`. Rodado
  duas vezes, uma com o connector `console` (sem enviar) e outra com o ZeptoMail, que entregou um
  email real. 409 testes verdes, `tsc` limpo, build do frontend limpo.


### 🆕 Serviço compartilhado de email com connectors (ZeptoMail) (2026-09-08)

O backend não tinha como mandar email (o `ops-alert.ts` já apontava "ou SES real" como backlog).
Agora tem, e o provedor é trocável sem tocar em nenhum chamador.

- **Port + connectors.** `src/common/ports/email-port.ts` define `EmailPort`; os connectors vivem em
  `src/email/connectors/` e são registrados num mapa table-driven (`connector-registry.ts`). Somar
  SES/Resend/Postmark é um arquivo novo mais uma linha no mapa: sem `switch` espalhado, sem chamador
  tocado. `EmailProviderName` sai das chaves do próprio mapa, então a lista de valores válidos nunca
  desalinha dos connectors que existem.
- **`OutboundEmail` carrega a garantia.** `EmailService` valida uma vez (endereço, assunto, corpo) e
  resolve o remetente default; o connector recebe um tipo que já provou isso e não re-valida nada. A
  validação mora ali porque o destinatário quase sempre vem do DynamoDB, que não valida nada por nós.
- **ZeptoMail por API, não SMTP.** A API devolve `request_id` e erro estruturado (`error.code` +
  `error.details[]`), então falha vira log acionável; SMTP devolve código numérico e texto livre. Sem
  SDK: é um POST JSON, e `fetch` mantém o padrão do `asaas-client`. As credenciais SMTP ficaram no
  `.env` por completude, sem connector.
- **Default seguro.** `EMAIL_PROVIDER` ausente cai no connector `console`, que só loga e não envia,
  mesma lógica do default sandbox do Asaas. Valor desconhecido derruba o boot em vez de virar email
  silenciosamente não enviado.
- **Dois erros distintos.** `EmailValidationError` (culpa de quem chamou, retentar não adianta) e
  `EmailDeliveryError` (provider falhou, pode ser transitório, carrega status/code/request_id).
  Timeout de 10s e falha de rede também viram `EmailDeliveryError`.
- **DNS já no ar.** Zona `licitahawk.com` (`Z0432805FV5S4B9AIEPM`, profile AWS `LicitaHawk`) ganhou os
  dois TXT de DKIM e o CNAME `bounce-zem`. O segundo DKIM tem 401 chars e foi gravado como duas
  strings adjacentes, porque uma string de TXT trava em 255.
- **Testado ao vivo:** `npm run send-test-email joaopster@proton.me` entregou um email real pelo
  ZeptoMail (request_id `2d6f.1213020124f85589...`). 27 testes de unidade no módulo; suíte completa
  com 389 testes verde.


### 🆕 Busca combinada UF+modalidade, paginação determinística e limpeza de payload (2026-09-08)

Três frentes numa rodada só, todas na mesma raiz: o formato dos índices do DynamoDB estava vazando
para dentro da API.

**1. UF e modalidade agora combinam.** Antes a API respondia `400` para `?uf=GO&modalidade=...`
("informe uf OU modalidade") porque `Tenders` só tinha GSI de `uf` e GSI de `modalidade` separados,
e o DynamoDB não intersecta dois índices. Isso nunca foi decisão de produto — tanto que
`SavedFilters` **exigia** os dois (GSI `uf+modalidade`), então dava para criar um alerta que a busca
ao vivo não conseguia reproduzir.

- Atributo derivado `uf_modalidade` (`${uf}#${modalidade}`) em `Tenders`, escrito só em
  `src/tenders/uf-modalidade-key.ts` (módulo puro, usado pela escrita **e** pela leitura — duplicar
  o formato entre os dois lados seria o bug mais silencioso possível).
- Nova `GSI4-uf_modalidade-data_publicacao`, `Projection: INCLUDE` sem `raw_payload`.
- `scripts/backfill-uf-modalidade.ts` (`npm run backfill-uf-modalidade`): **obrigatório** ao criar a
  GSI numa tabela com dados — GSI só indexa item que já tem o atributo. Idempotente
  (`attribute_not_exists`), retomável. **Rodado ao vivo: 6.150 itens, 0 falhas; segunda execução
  atualizou 0 e pulou 6.150.**
- `assertUfXorModalidade` → `assertUfOrModalidade`. Teto novo: o produto cartesiano uf × modalidade
  vira uma Query por par, então `MAX_QUERY_TARGETS = 12` (5×5 = 25 é `400`).

**2. Paginação de tamanho fixo (o bug relatado pelo usuário).** Buscar por UF + palavra-chave
devolvia 5 resultados, e cada "Carregar mais" trazia 1, 2, 0 — aleatório. Causa: o `Limit` do
DynamoDB corta **antes** do filtro, e keyword/valor eram filtrados em memória sobre uma página bruta
do tamanho do `limit`. Novo motor em `src/tenders/tender-query.ts`:

- **Página cheia:** continua lendo páginas do índice até juntar `limit` itens que passem em todos os
  filtros, ou esgotar os dados, ou bater o teto de leitura (40 Queries/requisição).
- **Multi-valor pagina:** merge k-way entre N streams com cursor único e opaco
  (`{v:2, k:{targetId: ExclusiveStartKey}, x:[esgotados]}`), gravado pelo último item **consumido**
  de cada stream. Item lido e não consumido é simplesmente relido — cursor stateless, sem duplicata
  nem item pulado. Isso aposentou a limitação "paginação não suportada com multi-valor" (backend e
  o botão desabilitado no frontend).
- Resposta ganhou `has_more` e `partial`. `partial: true` é o único caso em que uma página curta
  ainda tem continuação (teto de leitura atingido, não fim de dados).
- **Verificado ao vivo** (6.150 tenders reais no DynamoDB Local, 4 cenários × 3 páginas):
  20/20/20 itens em todos, 0 duplicados — inclusive multi-UF e 2 UFs × 2 modalidades.

**3. Melhorias de performance/usabilidade na mesma passada:**
- Rotas de **lista** não devolvem mais `raw_payload` (`ProjectionExpression` explícito). Nunca esteve
  no schema `Tender` da OpenAPI; o detalhe (`GetItem`) continua devolvendo. Tipo novo
  `TenderListItem = Omit<Tender, "raw_payload" | "uf_modalidade">` — o tipo passou a descrever o que
  existe de verdade em memória.
- `modalidade` em `GET /v1/tenders` agora é validada contra o domínio oficial do PNCP. Antes era
  texto livre: `?modalidade=pregao eletronico` respondia `200 []`, indistinguível de "não há nada".
- Filtros novos `municipio` e `situacao` (casam por trecho, sem acento e sem caixa), na busca, no
  órgão, no MCP e no critério salvo.
- `countNewMatchesForSavedSearch` usa o mesmo motor (combina uf+modalidade) e passou a **respeitar
  `dataInicial`/`dataFinal` do critério salvo**, que antes ignorava.
- `findRecentlyUpdatedMatches` (preview de webhook) lê a partição exata na GSI4 em vez de varrer a
  UF inteira filtrando modalidade em memória.
- Ingestão grava em `BatchWrite` de 25 (com retry de `UnprocessedItems`) em vez de um `PutItem` por
  licitação — ~25× menos round-trips por janela.

**Suíte em 389 passando** (+14 do motor novo, `src/tenders/tender-query.test.ts`). Typecheck e
`ng build` limpos. OpenAPI em `0.9.0`.

**Pendente para a Fase 7 (AWS real):** rodar `scripts/create-tables.sh` (cria a GSI4, passo
idempotente) e **depois** `npm run backfill-uf-modalidade` contra a tabela de produção.

### Licitações salvas (2026-09-08)

Favoritar uma licitação específica, com nota pessoal. Não confundir com o que já existia:
`SavedSearches` = critérios de busca salvos; `SavedFilters` = filtro que dispara webhook;
`SavedTenders` (novo) = a licitação que a pessoa marcou para acompanhar.

**Backend:** tabela `SavedTenders` (PK `account_id`, SK `pncp_control_number`),
`src/account/saved-tender.types.ts`, `saved-tenders.service.ts`, `saved-tenders.router.ts`
(5 rotas em `/v1/account/saved-tenders`, autenticadas por Cognito), 12 testes novos.
Suíte em **347 passando**.

**Frontend:** `/app/salvas` (`pages/saved-tenders/`), item na sidebar em Licitações, e botão
salvar/remover no cabeçalho da tela de detalhe.

**Decisões:**
- A chave composta resolve três coisas de uma vez, sem GSI: listar por conta (Query pela PK),
  responder "esta está salva?" (GetItem, sem Scan) e tornar salvar duas vezes idempotente por
  construção, em vez de exigir uma checagem antes de gravar.
- O item guarda um **snapshot** dos campos de exibição (objeto, órgão, valor, prazo) montado
  sempre a partir do tender indexado, nunca do payload do cliente. Dois motivos: a lista renderiza
  sem N leituras na tabela `Tenders`, e ninguém grava objeto/valor arbitrário controlando o POST.
- Sem estado central no `AccountService`: só duas telas consomem o dado e não há badge sincronizado
  em lugar nenhum.
- Prazo de propostas vira selo de atenção na lista, porque é o motivo real de alguém salvar uma
  licitação.

**Ajustes de UI feitos na revisão** (a tela tinha sido entregue com a tabela ocupando altura
demais): objeto e órgão truncados em uma linha com o texto completo no hover, município e UF como
segunda linha do órgão (em vez de coluna própria), nota como segunda linha do objeto, ações em
ícones (seta, lápis, lixeira) no lugar de três botões de texto, e **coluna de ações fixa com
`position: sticky`** para não ser a primeira coisa a sair da tela quando a tabela rola na
horizontal. Altura média de linha caiu de ~240px para 66px.

### 🆕 Detalhe completo da licitação, vindo do PNCP (2026-09-08)

A tela de uma licitação mostrava só o recorte que a ingestão indexa para busca. Agora mostra tudo
que o PNCP publica, com a intenção declarada de substituir a página do governo.

**Backend (novo):**
- `src/tenders/pncp-detail-client.ts` - cliente dos endpoints de detalhe, com `parseControlNumber`
  (quebra `CNPJ-1-SEQ/ANO`) e download de arquivo.
- `src/tenders/tender-detail.service.ts` - `getFullTender()`: cache no DynamoDB, revalidação e
  degradação por seção.
- Tabela nova `TenderDetails` (`scripts/table-defs/tender-details.json`, criada pelo
  `create-tables.sh` idempotente).
- `GET /v1/tenders/{id}` e `GET /v1/account/playground/tenders/{id}` agora devolvem `detail` e
  `detail_error`; aceitam `?refresh=1` (rebusca) e `?detail=cached` (responde na hora).
- 14 testes novos; suíte em **335 passando**. `openapi.yaml` em 0.8.0.

**Mapa da API do PNCP (medido contra a API real, não deduzido da doc):**

| dado | base | caminho |
|---|---|---|
| detalhe da compra | `/api/consulta/v1` | `/orgaos/{cnpj}/compras/{ano}/{seq}` |
| itens | `/api/pncp/v1` | `.../itens` |
| resultados do item | `/api/pncp/v1` | `.../itens/{n}/resultados` |
| arquivos | `/api/pncp/v1` | `.../arquivos` |
| histórico | `/api/pncp/v1` | `.../historico` |

**Três achados que custaram diagnóstico e não estão em documentação nenhuma:**
1. O detalhe da compra **mudou de base**: `/api/pncp/v1/orgaos/.../compras/...` responde 301 para
   `/api/consulta/v1/...`.
2. O endpoint de itens **não responde** com `accept: application/json` nem sem header `accept`: a
   conexão fica pendurada até o timeout. Com o curinga `*/*` responde em ~50ms. É o valor que os
   exemplos em curl do manual oficial usam.
3. Os endpoints de `/api/pncp/v1` **falham de forma intermitente** (confirmado com curl, não é o
   nosso cliente): em rajada, 20-40% das chamadas ficam penduradas e a seguinte passa em ~100ms.
   Daí o desenho: timeout curto (4s) com mais tentativas, `allSettled` por seção (uma seção fora
   não derruba a licitação inteira), `secoes_indisponiveis` declarado na resposta, cache parcial
   valendo 10 min em vez de 6h, e o botão "Atualizar do PNCP" na tela.

**Decisões de design:**
- Detalhe buscado **sob demanda**, não na ingestão: enriquecer tudo multiplicaria por 4+ o tráfego
  contra o PNCP para milhares de licitações/dia das quais quase nenhuma seria aberta.
- Revalidação por `data_atualizacao` do índice, não só por TTL: resultado homologado ou documento
  novo aparecem sem esperar as 6h.
- Tetos por item do DynamoDB (400 KB): 250 itens, 150 eventos de histórico, 60 chamadas de
  resultado. Truncamento é declarado na resposta e na tela, nunca silencioso.
- Frontend carrega em **duas etapas**: a tela abre com o indexado (~250ms) e o detalhe chega
  depois, em vez de segurar tudo esperando o PNCP.

**Frontend:** `pages/tender-detail-page/` reescrita (dados da contratação, itens com valor
unitário, resultado por item com fornecedor vencedor, documentos para download, histórico, JSON
cru e outras licitações do órgão). Validada ao vivo no browser.

**Pendências conhecidas:** o cliente de detalhe não conta uso por API key (a rota que o chama já
conta); o download de documento aponta direto para o PNCP, então não passa pelo nosso rate limit.

**O que é o projeto:** API REST + servidor MCP sobre dados oficiais de licitações públicas do PNCP (Brasil), com webhook de alerta e billing por assinatura (Asaas + nota fiscal via Focus NFe). Ver Seção 1 pra contexto de produto completo.

**Onde as coisas estão:** projeto em `C:\Users\joaop\Desktop\Repos\UtilAPInMCPs\licitahawk\`. **Virou monorepo (2026-09-07)**: `backend/` (tudo que antes vivia na raiz — `src/`, `docker-compose.yml`, `docs/`, `scripts/`, `.env`, `.env.example`, testes) e `frontend/` (novo, Angular, landing+login+pagamento+dashboard). `PLAN.md` e `legal/` continuam na raiz do monorepo (documentação/produto, não específicos de um lado). Todo comando de backend (`npm test`, `npx tsc --noEmit`, `docker compose`, etc.) agora roda **dentro de `backend/`**, não mais na raiz. `.env`/`.env.example` (chaves reais Asaas/Focus NFe + novo Cognito) ficam em `backend/.env` — nunca sobrescrever, só ler/completar.

**Exceção autorizada explicitamente pelo usuário (2026-09-07) à regra "100% local até a Fase 7":** Cognito User Pool real criado na AWS (conta `LicitaHawk`, via `aws-cli` puro, sem IaC) — `us-east-1_VtOEPrPpu`, App Client `31jjvqf9e7g0ksglgnv5mt3utk`, região `us-east-1`. Motivo: não existe emulador local viável pro fluxo de auth do frontend que valesse a pena nesse estágio; usuário autorizou a exceção depois de ser avisado do trade-off. Resto da regra (zero CDK/IaC, nada de Lambda/API Gateway/SQS/EventBridge reais ainda) continua valendo.

### 📋 Resumo executivo — o que as 10 rodadas juntas mudaram (se você leu este plano antes só até a Fase 6/Seção 12, comece aqui)

10 rodadas sequenciais (cada uma sem ver o trabalho das anteriores em detalhe, rodando sobre o código real já integrado) levaram o MVP local (Fases 1-6) de "funciona, foi revisado uma vez" (Seção 11) pra um estado com robustez de produção de verdade, suíte de testes automatizados real, e uma verificação cruzada final entre todas as rodadas. Dividido em 2 lotes: **Rodadas 1-5 = feature/robustez nova**, **Rodadas 6-10 = verificação cética + testes automatizados, deliberadamente sem feature nova**.

**Lote 1 (Rodadas 1-5 — feature e robustez):**
1. **Observabilidade do rate limit real do PNCP** — rastreamento empírico (2 tabelas DynamoDB, rota `/internal/rate-limit-metrics`), achado real no processo: PNCP também falha com `503`/`504`/erro de rede, não só `429`.
2. **API REST pronta pra integrador de verdade** — multi-UF/multi-modalidade, faixa de valor, ordenação, rate limit por minuto (distinto do teto mensal), cache de resposta curto, formato de erro padronizado, `/health` com dependência real checada.
3. **Servidor MCP útil pro fornecedor não-técnico** — 4 ferramentas novas (`get_tender_stats`, `delete_saved_filter`, `get_filter_deliveries`, `get_usage_stats`), respostas em texto legível, gaps de rate limit/validação fechados.
4. **Webhook/billing prontos pra alguém pagando de verdade** — fila de entrega durável (sobrevive a restart do processo), reconciliação periódica de `plan_tier` contra a API real do Asaas, alerta operacional estruturado, endpoint de reativação de filtro.
5. **Qualidade, testes automatizados, polish** — suíte Vitest real nasce aqui (93 testes), `npm audit` com `qs` resolvido, `openapi.yaml` sincronizado.

**Lote 2 (Rodadas 6-10 — verificação cética + testes, sem feature nova):** cada rodada releu com ceticismo o código que o lote 1 já tinha declarado pronto, ampliando a suíte de testes de 93 pra **224 testes**, e encontrou **6 bugs reais adicionais** que a implementação original e sua própria verificação ao vivo não tinham pego (ver lista completa na seção consolidada abaixo, "Bugs reais encontrados e corrigidos — as 10 rodadas"). A Rodada 10 (final) não encontrou bug novo — confirmou por releitura cruzada que as correções das Rodadas 6-9 são consistentes entre si e reconfirmou toda a suíte + smoke test ao vivo do zero.

**Não fez parte de nenhuma das 10 rodadas** (fora de escopo por instrução explícita em todas): Fase 7 (deploy AWS real), Fase 8 (validação de mercado/soft launch), e a investigação do Focus NFe/homologação (Seção 12, já fechada e com decisão do usuário registrada).

### 🆕 Conta do cliente (Cognito ↔ produto) + checkout Asaas real (2026-09-07, pós-monorepo)

Fecha a pendência #1 das "10 sugestões de melhoria" (API key só existia via script de dev). Novo módulo `backend/src/account/`, autenticado por ID token do Cognito (não API key) — liga a identidade do Cognito (`sub`) a uma conta do produto (`ApiKeys`: API key + `plan_tier` + billing) e cria o fluxo de checkout de assinatura via Asaas. Não tocou `src/billing/nfse-payload.ts` nem Fase 7/8.

**Novos arquivos:** `src/common/auth/cognito-auth.middleware.ts` (+ teste), `src/account/account.repository.ts`, `src/account/account.service.ts` (+ teste, 15 casos), `src/account/account.router.ts`. Estendidos: `src/config/env.ts` (`cognitoUserPoolId`/`cognitoClientId`/`cognitoRegion`/`frontendOrigin`), `src/common/auth/api-key.middleware.ts` (`hashApiKey` exportado, reusado pelo novo módulo), `src/common/auth/types.ts` (`ApiKeyRecord` ganhou `asaas_subscription_id`/`pending_plan_tier`/`checkout_invoice_url`/`email`), `src/billing/asaas-client.ts` (ganhou escrita: `createCustomer`/`createSubscription`/`getFirstPaymentForSubscription`/`getPixQrCode` — antes só tinha leitura), `src/server.ts` (CORS + router novo), `docs/openapi.yaml` (`securityScheme` `CognitoAuth`, 6 rotas novas, bump `0.3.0` → `0.4.0`), `scripts/table-defs/api-keys.json` + `scripts/create-tables.sh` (GSI nova).

**Rotas novas (todas `security: CognitoAuth`, `Authorization: Bearer <idToken>` do Cognito, formato de erro `{error:{code,message}}` padrão do projeto):**
- `POST /v1/account/provision` — idempotente. 1ª chamada: cria `ApiKeys` (`plan_tier: "free"`, `active: true`) e devolve `{ data: { customer_id, email, plan_tier, created_at, has_api_key: true, api_key: "<crua>" } }` — `api_key` só nessa chamada. Chamadas seguintes: mesmo formato **sem** o campo `api_key` (ausente, não `null`).
- `POST /v1/account/api-key/regenerate` — gera key nova, desativa a antiga (`active:false`, não deleta). `{ data: { api_key: "<crua>" } }`. 404 `ACCOUNT_NOT_PROVISIONED` se a conta não existe.
- `GET /v1/account/me` — `{ data: { customer_id, email, plan_tier, created_at, has_api_key } }`. Nunca a key. 404 se não provisionada.
- `GET /v1/account/usage` — `{ data: { plan, requestsThisMonth, monthlyLimit, monthlyRemaining, perMinuteLimit } }` — reusa `mcp/usage.service.ts::getMonthlyUsage`, zero duplicação. 404 se não provisionada.
- `POST /v1/account/checkout` — body **obrigatório** `{ plan: "starter"|"pro", cpfCnpj: string, name: string }` (decisão de design abaixo). Cria/reusa customer no Asaas (produção real) + assinatura recorrente mensal `billingType: "UNDEFINED"`. `{ data: { plan, checkout_url, pix_qr_code?: { encoded_image, payload, expiration_date? }, asaas_subscription_id } }`, HTTP 201. 400 `VALIDATION_ERROR` (plan/cpfCnpj/name ausente ou cpfCnpj com formato inválido). 404 se não provisionada.
- `GET /v1/account/subscription` — polling pós-checkout. `{ data: { plan_tier, pending_plan_tier: "starter"|"pro"|null, checkout_url: string|null } }`. `plan_tier` só muda quando o webhook `POST /webhooks/asaas` (já existente) confirma o pagamento; esta rota é leitura pura e limpa `pending_plan_tier`/`checkout_url` (via `REMOVE`, não `SET null`) assim que `plan_tier` já bate com o pendente.

**Decisões de design importantes pro frontend:**
1. **`cpfCnpj` e `name` são obrigatórios no checkout, não vêm do Cognito.** Confirmado na doc oficial do Asaas: `POST /v3/customers` exige `cpfCnpj` (só `name` + `cpfCnpj` são obrigatórios). O Cognito só garante `sub`/`email` — não há CPF/CNPJ nem nome completo garantido no ID token (depende de o frontend ter configurado atributos customizados, o que não foi feito). **O frontend precisa de uma etapa de formulário (nome + CPF/CNPJ) antes de chamar `/checkout`.**
2. **`billingType: "UNDEFINED"` na assinatura** (não força Pix nem boleto) — é o padrão recomendado pela doc do Asaas quando a integração quer aceitar múltiplas formas de pagamento sem construir formulário de cartão próprio (PCI). O cliente escolhe boleto/cartão/Pix na fatura hospedada (`checkout_url` = `invoiceUrl` da 1ª cobrança da assinatura, buscada via `GET /v3/payments?subscription=`). `pix_qr_code` é preenchido best-effort (`GET /v3/payments/{id}/pixQrCode`) — pode vir ausente mesmo com Pix disponível na fatura (timing), o frontend deve sempre ter `checkout_url` como fallback garantido.
3. **`ApiKeys` ganhou uma 2ª GSI** (`GSI-customer-id`, hash em `customer_id`) — a única forma de achar "esse usuário Cognito já tem conta?" a partir do `sub`, já que a PK real da tabela é `api_key_hash`. Aplicada ao vivo no DynamoDB Local (tabela já existia com 20 itens de dev, `update-table` idempotente, sem downtime/perda de dado) e adicionada como passo idempotente em `create-tables.sh` (mesmo padrão dos passos de TTL já existentes) — vai rodar sozinha quando o script for reexecutado contra a AWS real na Fase 7.
4. **Regenerar API key não é um `UPDATE`** — a PK é o próprio hash, então regenerar cria um registro novo (novo `api_key_hash`) e desativa o antigo (`active:false`, mantido por auditoria/histórico, nunca deletado).
5. **CORS**: `cors` novo no `package.json`, aplicado global em `server.ts` (antes de todos os routers) com origem única vinda de `FRONTEND_ORIGIN` (default `http://localhost:4200`, documentado em `.env.example`/`.env`).

**Testado:**
- `npx tsc --noEmit` limpo, `npm test`: **244/244 testes passando** (220 herdados + 20 novos: 5 do middleware Cognito + 15 do `account.service`, todos mockando DynamoDB/Asaas via `vi.mock`, mesmo padrão do resto do projeto).
- **Ao vivo, real, servidor rodando + DynamoDB Local real (não mock)**: `provisionAccount`→`getAccountInfo`→`getAccountUsage`→`regenerateApiKey` executados em sequência contra a tabela `ApiKeys` de verdade via a `GSI-customer-id` nova (script descartável, dados de teste limpos depois). `cognitoAuthenticate` testado via HTTP real contra o servidor: sem header → 401; com token inválido → 401 **com chamada de rede real ao JWKS do User Pool real** (`us-east-1_VtOEPrPpu`) confirmando que a verificação de assinatura funciona ponta a ponta, não só mockada. CORS confirmado via curl (`Access-Control-Allow-Origin: http://localhost:4200`).
- **NÃO testado ao vivo**: `POST /v1/account/checkout` fim-a-fim contra o Asaas real — a chave em `.env` é de **produção** (`ASAAS_API_KEY_PROD`), então uma chamada real criaria um customer/assinatura de verdade na conta Asaas do usuário; deliberadamente não executado sem aprovação explícita (mesma cautela de "ações difíceis de reverter"). Lógica coberta pelos 6 testes unitários de `startCheckout` (customer novo, customer reusado, validação de plano/cpfCnpj, Pix indisponível, conta não provisionada) com o cliente Asaas mockado. **Também não foi possível gerar um ID token real do Cognito** (exigiria um usuário cadastrado de verdade no User Pool) — o middleware foi validado ao vivo só no caminho de rejeição (token ausente/inválido); o caminho de sucesso (`req.cognitoUser` populado) tem cobertura só de teste unitário (verifier mockado) + leitura de código.
- **Pendente pro frontend (próximo agente)**: montar a tela de checkout coletando nome + CPF/CNPJ antes de chamar `/v1/account/checkout`; implementar o signup/login direto contra o Cognito (SDK no browser) e mandar o ID token no header; fazer polling em `GET /v1/account/subscription` após redirecionar pro `checkout_url`.

### 🆕 Frontend Angular construído (landing + login + pagamento + dashboard) (2026-09-07)

Fecha a pendência acima. `frontend/` (Angular 22, standalone components, sem NgRx) ganhou as 4 telas completas descritas no escopo, autenticação real contra o Cognito via `amazon-cognito-identity-js` (SRP client-side, sem Amplify) e consumo completo do módulo de conta do backend (`/v1/account/*`). Não tocou `backend/` (nenhum arquivo) nem Fase 7/8.

**Estrutura nova:**
- `frontend/src/app/config.ts` — `APP_CONFIG` (`apiUrl: http://localhost:3000`, `cognito.userPoolId/clientId/region`).
- `frontend/src/app/core/auth.service.ts` — wrapper de `amazon-cognito-identity-js`: `signUp`, `confirmSignUp`, `resendConfirmationCode`, `login`, `logout`, `getSession` (com refresh automático via refresh token), `getIdToken`, `isAuthenticated`; expõe `currentEmail` como `signal`.
- `frontend/src/app/core/account.service.ts` — `HttpClient` para as 6 rotas de `/v1/account/*` (`provision`, `regenerateApiKey`, `getMe`, `getUsage`, `checkout`, `getSubscription`); expõe `justProvisionedApiKey` (`signal`) setado por `provision()`/`regenerateApiKey()` — é como o dashboard sabe mostrar o banner "copie agora" só uma vez.
- `frontend/src/app/core/auth.guard.ts` — `CanActivateFn` assíncrono, usado em `/dashboard` e `/payment`.
- `frontend/src/app/core/auth.interceptor.ts` — `HttpInterceptorFn` funcional, anexa `Authorization: Bearer <idToken>` automaticamente só nas chamadas pra `${apiUrl}/v1/account/*`.
- `frontend/src/app/core/cognito-error.util.ts` — mapeia `err.code` do Cognito (`UsernameExistsException`, `InvalidPasswordException`, `NotAuthorizedException`, `CodeMismatchException`, `ExpiredCodeException`, etc.) pra mensagem em português.
- `frontend/src/app/pages/{landing,login,payment,dashboard}/` — 4 componentes standalone lazy-loaded via `loadComponent` em `app.routes.ts`.
- `frontend/src/styles.scss` — design system global (tokens de cor navy+dourado, tipografia Sora/Inter via Google Fonts, `.btn`/`.card`/`.form-*`/`.badge`/`.alert`) reusado pelas 4 telas.

**Decisões/achados técnicos relevantes:**
1. **Bug real encontrado e corrigido**: `amazon-cognito-identity-js` lança `Uncaught ReferenceError: global is not defined` no browser (depende de `global` do Node, via `buffer`/`@aws-crypto/sha256-js`). Um polyfill `window.global = window` no topo de `main.ts` **não resolve** — imports ES module são hoisted, então o código do Cognito (importado transitivamente por `app.config.ts`) roda antes de qualquer statement do próprio `main.ts`, mesmo os escritos acima do `import`. Corrigido com um `<script>window.global = window;</script>` inline em `frontend/src/index.html`, que garantidamente roda antes de qualquer bundle.
2. **Porta 4200 já ocupada** por outro projeto do usuário (dev server já rodando). `ng serve` roda nesta sessão em **`--port 4201`**. Como o CORS do backend é fixo em `FRONTEND_ORIGIN` (lido uma vez no boot), o processo do backend desta sessão foi reiniciado com `FRONTEND_ORIGIN=http://localhost:4201` como variável de ambiente (não editado o `.env`). **Se o próximo agente/usuário rodar em outra porta (ex.: 4200 livre de novo), precisa subir o backend com o `FRONTEND_ORIGIN` correspondente ou usar o default 4200.**
3. `angular.json`: budget `anyComponentStyle` (`maximumWarning`) subido de `4kB` pra `6kB` — só a landing (rica em seções) passava um pouco do limite; não é sintoma de CSS inchado, é uma página de marketing legítima com mais conteúdo.
4. Warnings de build (`buffer`/`@aws-crypto/sha256-js`/`isomorphic-unfetch` não são ESM) são inofensivos — vêm de dentro do `amazon-cognito-identity-js`, não afetam o bundle funcional, `ng build` termina com sucesso mesmo assim.

**🐛 Bug real encontrado no backend (fora do meu escopo consertar — `frontend/` é tudo que este agente edita — reportar pro agente/dono do módulo de conta):**
- **`findAccountByCustomerId` (`backend/src/account/account.repository.ts:13-24`) pode retornar o registro ERRADO depois de `regenerateApiKey`.** A função faz `Query` na `GSI-customer-id` com `Limit: 1` e **sem** `ScanIndexForward`/filtro em `active`. Como `regenerateApiKey` (`backend/src/account/account.service.ts:82-97`) cria um **novo** item (novo `api_key_hash`, mesmo `customer_id`) em vez de fazer `UPDATE` no antigo (que só é marcado `active:false`), depois de regenerar existem **2 itens com o mesmo `customer_id`** na GSI — e a query com `Limit:1` pode devolver o item antigo (desativado) em vez do novo. **Reproduzido ao vivo nesta sessão**: login → `provision` (cria key) → `regenerateApiKey` (nova key confirmada na UI, diferente da anterior) → reload do dashboard → `GET /v1/account/me` retornou `has_api_key:false` (deveria ser `true`), confirmado inspecionando a resposta HTTP real (`customer_id: e4881488-50a1-70b5-669f-ff564bde3108`, `active` da key errada sendo lido). O mesmo problema provavelmente afeta `getAccountUsage`/`startCheckout` (todos chamam `findAccountByCustomerId`), não só `has_api_key`. **Não corrigido por mim** (fora do escopo "constrói tudo dentro de `frontend/`") — precisa de um fix no backend (ex.: ordenar a GSI por `created_at` desc e pegar o primeiro, ou filtrar `active = true` na query, ou usar um ponteiro estável tipo `active_api_key_hash` num item separado por `customer_id`).

**Testado AO VIVO (Cognito real + backend real + DynamoDB Local real, via Chrome DevTools MCP, `ng serve --port 4201`):**
- Usuário de teste criado via `aws cognito-idp admin-create-user`/`admin-set-user-password` (`teste@licitahawk.local`, senha permanente, sem passo de confirmação) exatamente como documentado no briefing.
- **Landing (`/`)**: renderiza sem erro de console, todas as seções (hero, produto, personas, 3 planos, CTA final), links `Criar conta grátis`/`Entrar` levam pra `/login`.
- **Login → provision → dashboard, fim a fim**: login real (`POST` pro Cognito `cognito-idp.us-east-1.amazonaws.com`, 200), `POST /v1/account/provision` (200, `has_api_key:true` + `api_key` crua na 1ª chamada), redirecionamento automático pra `/dashboard`, banner da API key exibido com botão copiar.
- **Regenerar chave**: confirmação inline (Confirmar/Cancelar) testada, `POST /v1/account/api-key/regenerate` (200) retornou uma chave diferente da anterior, confirmado comparando os dois valores na tela.
- **Guard de rota**: logout testado (limpa sessão, `cognitoUser.signOut()`, volta pra `/login`); navegação direta pra `/dashboard` e `/payment` sem sessão redirecionou pra `/login` nos dois casos (`authGuard` funcionando).
- **Signup real contra o Cognito** (não só até o envio — o usuário criado ficou sem confirmar por não haver caixa de entrada real de teste, removido depois com `admin-delete-user`): `signUp()` real disparado com sucesso pra um email de teste, UI avançou pro passo de código; **erro de código incorreto testado** (`CodeMismatchException` → "Código de confirmação incorreto."); **erro de email duplicado testado** (`UsernameExistsException`, usando o email do usuário de teste já existente → "Já existe uma conta cadastrada com este email."); validação client-side de senha fraca testada (bloqueia antes de qualquer chamada de rede).
- **Pagamento (`/payment`)**: acessível só autenticado (guard confirmado), seleção de plano Starter/Pro funcional, validação de CPF/CNPJ testada (`"123"` → erro "CPF/CNPJ inválido..." **confirmado via `list_network_requests` que nenhuma chamada `/v1/account/checkout` foi disparada** — a validação client-side bloqueia antes do `HttpClient.post`). **Deliberadamente NÃO submetido um CPF/CNPJ válido** — isso chamaria `POST /v1/account/checkout` de verdade contra o Asaas de **produção** (mesma cautela documentada na seção do backend acima). Lógica revisada por leitura de código: `checkout()` → `startCheckout` (backend) já tem 6 testes unitários cobrindo esse caminho.
- `npx ng build`: limpo (só os 3 warnings CommonJS inofensivos do `amazon-cognito-identity-js`, sem erro). `npx ng test --watch=false`: 1/1 passando (`app.spec.ts`, ajustado pra não depender mais do placeholder do `ng new`).

**NÃO testado (pendente pro usuário, ação manual explicitamente evitada por segurança/custo):**
- `POST /v1/account/checkout` com dados válidos, fim-a-fim contra o Asaas de produção real (criaria cobrança/assinatura de verdade) — testar manualmente quando o usuário quiser, preenchendo nome + CPF/CNPJ reais na tela `/payment` já логada.
- Confirmação de signup ponta a ponta com código real recebido por email (o teste desta sessão só foi até o envio do código + tratamento de erro de código incorreto, sem inbox real disponível).
- Polling pós-checkout em `GET /v1/account/subscription` até o `plan_tier` mudar (depende do checkout real acima ter sido feito).

**Como rodar:**
```bash
# backend (porta 3000) — se subir numa porta de frontend diferente de 4200, ajustar FRONTEND_ORIGIN
cd backend && FRONTEND_ORIGIN=http://localhost:4201 npx tsx src/server.ts

# frontend (porta 4200 ocupada por outro projeto nesta máquina — usar 4201 ou a porta livre)
cd frontend
export PATH="/c/Users/joaop/AppData/Local/nvm/v22.22.3:$PATH"   # Node 22.22.3, exigido pelo Angular CLI 22
npx ng serve --port 4201
```

### 🧪 Sandbox do Asaas conectado (2026-09-07)

Usuário criou conta em `sandbox.asaas.com` e gerou uma API key de sandbox — fechava a pendência da Fase 0.2 (só existia chave de produção). `backend/src/billing/asaas-client.ts` ganhou `ASAAS_ENV` (mesmo padrão do `FOCUS_ENV` já usado no Focus NFe: só vira `"producao"` com esse valor EXATO, qualquer outra coisa cai em `sandbox` — default seguro). `.env`/`.env.example` documentam `ASAAS_API_KEY_SANDBOX`/`ASAAS_ENV`. **Default local agora é `sandbox`.**

**Testado AO VIVO contra o sandbox real (não mock):** `GET /customers` direto confirmou a chave válida; login real do usuário de teste via Cognito (`initiate-auth`, token real) → `POST /v1/account/checkout` (plano Starter, CPF de teste) → resposta real do Asaas sandbox com `checkout_url` (`sandbox.asaas.com/i/...`) e `asaas_subscription_id` reais → `GET /v1/account/subscription` confirmou `pending_plan_tier:"starter"`. Fluxo de checkout provado ponta a ponta sem tocar produção.

**Como o usuário confirma o pagamento fake e vê o `plan_tier` mudar**: abrir o `checkout_url` no navegador, pagar com os dados de teste do Asaas sandbox (cartão de teste na doc oficial, ou Pix simulado). Sem túnel público (`ngrok` etc.), o webhook `POST /webhooks/asaas` não alcança o `localhost` — rodar `npx tsx scripts/run-reconciliation-once.ts` (dentro de `backend/`) depois de pagar pra puxar o status direto do Asaas sandbox e atualizar `plan_tier` manualmente, sem esperar os 30min do job periódico.

**🐛 Bug real encontrado e corrigido nesse teste (2026-09-07)**: usuário pagou com cartão de teste, Asaas confirmou (`status: CONFIRMED` de verdade, `billingType: CREDIT_CARD`), mas `run-reconciliation-once.ts` devolveu `checked: 0` — o pagamento simplesmente não aparecia. Causa raiz em `listPaymentsByStatusSince` (`asaas-client.ts`): o filtro usava `paymentDate[ge]`, campo que o Asaas só preenche pra boleto/Pix — pagamento confirmado por **cartão de crédito fica com `paymentDate: null` pra sempre** (usa `confirmedDate`/`clientPaymentDate`). Isso significa que **todo pagamento por cartão sempre foi invisível pra reconciliação**, desde a Rodada 9 quando ela foi criada — não era um problema só do teste local, era um buraco real no Risco #13 (webhook não entregue → `plan_tier` desatualizado) especificamente pro meio de pagamento mais comum. Corrigido: filtro trocado pra `dateCreated[ge]` (sempre preenchido, independente do meio de pagamento). `npx tsc --noEmit` limpo, `npm test` 244/244 (nenhum quebrou), e **reconfirmado ao vivo**: rodou `run-reconciliation-once.ts` de novo contra o mesmo pagamento real do sandbox → `checked:1, driftFound:1, driftFixed:1`, `plan_tier` do cliente de teste foi de `free` pra `starter` de verdade no DynamoDB Local.

### 🐛 Fix pós-frontend: `findAccountByCustomerId` podia devolver a chave desativada (2026-09-07)

O agente do frontend achou ao vivo (testando `/dashboard` de verdade contra o Cognito real + backend real): depois de `POST /v1/account/api-key/regenerate`, `GET /v1/account/me` às vezes voltava `has_api_key:false` mesmo com uma chave ativa existindo. Causa raiz em `backend/src/account/account.repository.ts::findAccountByCustomerId` — a query na `GSI-customer-id` usava `Limit: 1` sem `FilterExpression`; regenerar deixa 2+ itens com o mesmo `customer_id` (o antigo desativado + o novo ativo) e o DynamoDB aplica `Limit` **antes** do filtro, então o `Limit:1` podia "gastar" o único resultado no item errado (inativo) e devolver `undefined`. A GSI não tem sort key pra garantir "mais recente primeiro", então a correção foi remover o `Limit` (volume por cliente é sempre pequeno, 1-3 itens na prática) e filtrar por `active` em memória, com fallback pro primeiro item se nenhum estiver ativo (nunca deveria acontecer, mas evita `undefined` espúrio).

Afeta as 3 funções que dependem dela: `getAccountInfo`, `getAccountUsage`, `startCheckout`. Corrigido, `npx tsc --noEmit` limpo, `npm test` **244/244** (nenhum teste quebrou), e **reproduzido e confirmado ao vivo**: script descartável chamando `findAccountByCustomerId` direto contra o `customer_id` real do usuário de teste (`teste@licitahawk.local`, que já tinha passado por um `regenerate` no teste do frontend) — antes do fix reproduzia o bug relatado, depois do fix devolveu o item `active:true` correto.

### 🆕 Dashboard v2 (backend): múltiplas API keys, uso diário, webhooks/MCP via conta (2026-09-07, pós-Rodada 10)

Backend do redesign do dashboard (o Angular em si fica pro próximo agente). Expande `backend/src/account/` com 5 blocos de feature, todos reusando lógica já existente (nenhuma duplicação de CRUD/validação/dispatch) + 1 bug real corrigido. Não tocou `src/billing/nfse-payload.ts` (Seção 12, fechada), Fase 7/8, nem o checkout Asaas em si (`account.service.ts::startCheckout` inalterado).

**1. Múltiplas API keys nomeadas com expiração** (substitui o modelo de 1-chave-por-cliente):
- `ApiKeyRecord` (`src/common/auth/types.ts`) ganhou `name: string` e `expires_at: string | null`.
- Novo `src/account/api-keys.service.ts`: `createApiKey`, `listApiKeys`, `updateApiKey`, `revokeApiKey`, `parseExpiresAt`.
- `POST /v1/account/api-keys` (CognitoAuth) — body `{ name: string, expires_at?: string|null }` → cria uma linha NOVA (nunca substitui as existentes), `plan_tier` copiado da conta atual (via `findAccountByCustomerId`). 201 `{ data: { id, name, created_at, expires_at, active:true, api_key:"<crua>" } }` — `id` = o próprio `api_key_hash` (não reversível, seguro como identificador), `api_key` só aparece aqui. 400 `VALIDATION_ERROR` (name vazio/ausente, `expires_at` não-ISO). 404 `ACCOUNT_NOT_PROVISIONED` se a conta nunca foi provisionada.
- `GET /v1/account/api-keys` — todas as linhas (ativas E revogadas), ordenadas por `created_at` ascendente. `{ data: [{ id, name, created_at, expires_at, active }] }` — nunca `api_key`.
- `PATCH /v1/account/api-keys/:id` — body `{ name?, expires_at? }`, pelo menos um obrigatório (400 senão). `id` = api_key_hash. **Proteção IDOR**: a PK real da tabela é só o hash (sem `customer_id` na key), então o service busca por `GetCommand` e confere `record.customer_id === sub` manualmente antes de aceitar — chave de outro cliente responde 404 `NOT_FOUND` (nunca vaza que existe). 200 `{ data: ApiKeySummary }`.
- `POST /v1/account/api-keys/:id/revoke` — `active:false` (nunca deleta, mesmo padrão de auditoria já usado). Mesma proteção IDOR do PATCH. 200 `{ data: { id, active:false } }`.
- **`authenticate` (`api-key.middleware.ts`) agora rejeita chave expirada**: se `record.expires_at` preenchido e no passado → 401 `UNAUTHORIZED` ("API key expirada."), mesmo formato de erro do resto do middleware. Sem isso, `expires_at` seria só um campo decorativo sem efeito real.
- `POST /v1/account/provision` continua idempotente, mas agora a checagem de "conta já existe" é "tem QUALQUER linha (ativa ou revogada)" — a primeira chave criada chama-se `"Default"`, `expires_at: null`.
- **Removido**: `POST /v1/account/api-key/regenerate` (endpoint antigo de 1-chave-só) — função `regenerateApiKey` deletada de `account.service.ts`, rota removida de `account.router.ts`, seção removida do `openapi.yaml`. O frontend v1 usava esse endpoint, mas o dashboard está sendo reconstruído do zero (autorizado pelo lead, sem exigência de compatibilidade).

**2. Bug real corrigido: `setPlanTierForAsaasCustomer` só atualizava 1 linha por cliente** (`src/billing/customer-plan-sync.ts`) — achado real pré-existente, exposto pelo item 1 acima (múltiplas chaves por cliente virando norma). A `Query` na `GSI-asaas-customer-id` pegava só `res.Items?.[0]` (o primeiro item que a GSI devolvesse, sem filtro de `active`) — com 2+ chaves ativas do mesmo cliente, um upgrade/downgrade de plano só atualizava UMA, deixando as demais autenticando com `plan_tier` desatualizado pra sempre (`authenticate` lê `plan_tier` direto da linha da chave usada na requisição). **Corrigido**: Query sem `Limit`, filtra `active` em memória (mesmo padrão do fix anterior em `account.repository.ts::findAccountByCustomerId`), e agora faz um `UpdateCommand` em CADA linha ativa cujo tier ainda não bate com o novo (`Promise.all`, paralelo). `PlanSyncResult.updated: boolean` virou `PlanSyncResult.updatedCount: number` — ajustados os 3 chamadores: `upgradePlanForAsaasCustomer` (retorna `updatedCount > 0`), `downgradeToFreeForAsaasCustomer` (dispara `opsAlert` UMA vez, não por chave, quando `updatedCount > 0`), `reconciliation.service.ts` (`sync.updatedCount > 0`), `asaas-webhook.router.ts` (`downgraded: result.updatedCount > 0`).
  - **Testado AO VIVO contra DynamoDB Local real** (não só unitário): criadas 3 chaves ativas + 2 inativas pro mesmo `customer_id`/`asaas_customer_id` real (conta de teste `teste@licitahawk.local`, já linkada ao Asaas sandbox desde a rodada anterior) — script descartável chamando `setPlanTierForAsaasCustomer(asaasCustomerId, "pro")` direto → `updatedCount:3`, as 3 linhas ativas viraram `plan_tier:"pro"` de verdade no DynamoDB, as 2 inativas ficaram intocadas nos tiers antigos. **Confirmado também via requisição HTTP real**: uma das chaves atualizadas, usada contra `GET /v1/tenders`, devolveu `X-RateLimit-Limit: 600` (Pro), antes seria `180` (Starter) — prova que `authenticate` está lendo o tier propagado, não só que o DynamoDB foi escrito certo. Dado de teste revertido ao estado anterior (`plan_tier` de volta pra `"starter"`, chaves extras revogadas) ao final.

**3. Uso diário (REST vs MCP), últimos 30 dias, zero-preenchido:**
- Nova tabela `UsageDaily`: PK `customer_id`, SK `date` (`YYYY-MM-DD`), campos `rest_count`/`mcp_count`, TTL 60 dias (campo `ttl`). `scripts/table-defs/usage-daily.json` + passo de TTL idempotente em `create-tables.sh` (mesmo padrão de `RateLimitEvents`/`ClientRateLimits`). **Criada ao vivo no DynamoDB Local** (`create-tables.sh` reexecutado, `OK: UsageDaily criada` + `OK: TTL habilitado`).
- Novo `src/common/usage-daily.repository.ts`: `incrementDailyUsage(customerId, "rest"|"mcp")` (UpdateItem `ADD`, mesmo padrão atômico de `UsageCounters`/`ClientRateLimits`) e `getDailyUsageForLast30Days`/`last30DayDates`. `incrementDailyUsage` **NUNCA lança** (try/catch interno, só loga) — é telemetria pro dashboard, não pode atrasar/derrubar a requisição real do cliente (mesma filosofia de `rate-limit-tracking.ts`).
- Incrementado em `src/common/client-rate-limit.ts::clientRateLimit`, logo após `incrementAndCheckMonthlyUsage` (mesmo ponto, independente de `monthly.exceeded` — espelha a semântica de `UsageCounters`, que também conta a requisição que estoura o teto mensal; nunca conta requisição barrada pelo limite por minuto, já que esse ponto só é alcançado depois de passar por ele). REST vs MCP derivado de `req.path === "/mcp"` (rota MCP montada direto na raiz do app) — não mudou a assinatura de `api-key.middleware.ts`.
- `GET /v1/account/usage/daily` (CognitoAuth) — `{ data: { days: [{ date, rest_count, mcp_count, total_count }] (30 itens, mais antigo→mais recente, zero-preenchido), totalRest, totalMcp } }`. **Não exige conta provisionada** (diferente das outras rotas `GET /v1/account/*`) — é agregação pura sobre `UsageDaily`; cliente sem tráfego legitimamente tem uso zerado, não é erro.
- **Testado AO VIVO**: 3 chamadas REST + 1 chamada MCP real (`POST /mcp` initialize) com uma chave de teste → `GET /v1/account/usage/daily` mostrou o dia de hoje com `rest_count:4` (a 4ª foi uma chamada anterior com outra chave da mesma conta, antes de ser revogada), `mcp_count:1`, os 30 dias presentes e zero-preenchidos.

**4. Webhooks (filtros salvos) via conta, autenticado por Cognito** (dashboard não pede a API key do produto ao usuário):
- Novo `src/account/account-webhooks.router.ts`, montado em `/v1/account/webhooks` (registrado em `server.ts` via `app.use(accountWebhooksRouter)`). Reusa `src/filters/filters.service.ts` inteiro — troca só de onde vem `customer_id` (`req.cognitoUser.sub`) e de onde vem `plan_tier` (não existe em `req.auth` no fluxo Cognito; lido via `findAccountByCustomerId`).
- `SavedFilter` (`src/webhook/filter.types.ts`) ganhou `name: string | null`; `createFilter`/`CreateFilterInput` (`filters.service.ts`) ganharam `name` opcional (trim, `null` se ausente/vazio).
- Novo em `filters.service.ts`: `updateOwnedFilter(customerId, filterId, {name?, webhook_url?})` (update parcial com checagem de dono via `assertFilterOwnership`, `UpdateExpression` dinâmico igual ao padrão de `account.repository.ts::updateAccountFields`) e `regenerateFilterSecret(customerId, filterId)` (novo `webhook_secret` CSPRNG, nunca retornado).
- Novo `src/webhook/webhook-test-dispatch.ts::dispatchTestWebhook(filter)` — extraído de dentro de `webhook.router.ts` (era função local não-exportada) pra ser reusado por `/v1/account/webhooks/:id/test` sem duplicar o payload de teste/enqueue. `webhook.router.ts` (`POST /v1/filters/:id/test`) também migrado pra usar essa função compartilhada.
- `GET /v1/account/webhooks` — `{ data: [{ id (=filter_id), name, uf, modalidade, keyword, webhook_url, active, consecutive_failures, created_at }] }`, nunca `webhook_secret`/`customer_id`.
- `POST /v1/account/webhooks` — body `{ uf, modalidade, webhook_url, keyword?, name? }` (uf/modalidade/webhook_url obrigatórios, validados com `assertValidUf`/`assertValidWebhookUrl` de `query-validation.ts`, reusados). Enforcement de plano igual a `POST /v1/filters` (`webhooksEnabled`/`maxFilters` de `PLANS[planTier]`). 201 mesmo shape do GET. 400 `VALIDATION_ERROR`, 403 `PLAN_LIMIT_EXCEEDED`, 404 `ACCOUNT_NOT_PROVISIONED`.
- `PATCH /v1/account/webhooks/:id` — body `{ name?: string|null, webhook_url? }`, pelo menos um obrigatório (400 senão). 200 item atualizado. 404 `NOT_FOUND` (mesma proteção IDOR estrutural de `SavedFilters`, chave composta `customer_id`+`filter_id`).
- `DELETE /v1/account/webhooks/:id` — 204, 404 `NOT_FOUND`.
- `POST /v1/account/webhooks/:id/test` — 202 `{status:"queued"}` (mesmo dispatcher de `/v1/filters/:id/test`). 404 `NOT_FOUND`.
- `POST /v1/account/webhooks/:id/reactivate` — 200 `{status:"reactivated"}` (mesma lógica de circuit breaker, `circuit-breaker.ts::reactivateFilter`). 409 `FILTER_NOT_DISABLED` se o filtro já está ativo. 404 `NOT_FOUND`.
- `POST /v1/account/webhooks/:id/regenerate-secret` — **NOVO** (não existe nem no lado API-key). 200 `{ data: { id, secret_regenerated: true } }` — secret nunca retornado, só usado internamente pra assinar o HMAC do disparo.
- **Testado AO VIVO, ciclo completo**: criar (`uf:GO`, `name:"Meu alerta GO"`) → `PATCH` renomeando → `POST .../test` (202, e o circuit breaker real incrementou `consecutive_failures` pra 1, porque o `webhook_url` de teste `127.0.0.1:9999` não tem nada escutando — confirma que o dispatcher real rodou, não um mock) → `POST .../reactivate` num filtro ainda ativo → confirmado `409 FILTER_NOT_DISABLED` → `POST .../regenerate-secret` → `GET` confirmando o secret nunca aparece → `DELETE` → `GET` confirmando lista vazia.

**5. Info do MCP (seção informativa do dashboard):**
- `src/mcp/mcp.router.ts` ganhou `export const MCP_TOOLS_INFO: {name,description}[]` — fonte única das 8 descrições de tool (antes só existiam como literais inline dentro de cada `registerTool()`). Os 8 `registerTool()` agora referenciam `toolDescription("nome_da_tool")` em vez do texto duplicado — nenhuma descrição foi reescrita, só extraída pra um array compartilhado.
- `GET /v1/account/mcp-info` (CognitoAuth) — `{ data: { mcp_url: "http://localhost:<PORT>/mcp", tools: MCP_TOOLS_INFO } }`. `mcp_url` construído a partir de `env.port` (ainda `localhost`-only, pré-Fase-7, sem domínio real).
- **Testado AO VIVO**: 200, `mcp_url` correto, 8 tools retornadas com as MESMAS descrições registradas no servidor MCP real (mesma fonte, `MCP_TOOLS_INFO`).

**Decisões de design / limitações pro próximo agente (frontend):**
1. **Divergência de campos de conta entre múltiplas chaves (documentado, NÃO corrigido -- fora do escopo pedido)**: `email`/`asaas_customer_id`/campos de checkout (`asaas_subscription_id`, `pending_plan_tier`, `checkout_invoice_url`) continuam vivendo na linha que `findAccountByCustomerId` escolher (qualquer linha ATIVA, sem ordenação garantida -- GSI sem sort key). Só a propagação de `plan_tier` foi corrigida (bug explicitamente pedido pelo lead). `POST /v1/account/api-keys` já copia `email`/`asaas_customer_id` da conta pra chave nova no momento da criação (mitigação, não fix completo) -- mas um checkout iniciado com 2+ chaves ativas ainda poderia gravar `asaas_subscription_id`/`pending_plan_tier` numa linha diferente da que um `GET /v1/account/subscription` posterior lê. Risco baixo na prática (checkout é ação única por sessão), mas vale nota pra quem for revisitar isso.
2. `GET /v1/account/usage/daily` não dá 404 pra conta não-provisionada (diferente de toda outra rota `GET /v1/account/*`) -- deliberado, é agregação pura, zero uso é resposta válida.
3. `PATCH /v1/account/api-keys/:id` e `PATCH /v1/account/webhooks/:id` exigem pelo menos 1 campo no body (400 `VALIDATION_ERROR` em body vazio) -- guarda de "nada pra atualizar", consistente com o padrão de validação do resto do projeto.

**Testado:**
- `npx tsc --noEmit` limpo. `npm test`: **279/279 testes passando** (244 herdados + 35 novos: expiração de chave em `api-key.middleware.test.ts`, incremento diário em `client-rate-limit.test.ts`, `customer-plan-sync.test.ts` reescrito cobrindo múltiplas chaves, testes novos em `account.service.test.ts` pra uso diário, e 3 arquivos de teste novos -- `account/api-keys.service.test.ts`, `common/usage-daily.repository.test.ts`, `filters/filters.service.test.ts`).
- **Ao vivo, real, servidor rodando (reiniciado com o código novo, `FRONTEND_ORIGIN=http://localhost:4201` preservado) + DynamoDB Local real**: ID token real do Cognito obtido via `aws cognito-idp initiate-auth` (`USER_PASSWORD_AUTH`, usuário de teste já existente `teste@licitahawk.local`, senha resetada via `admin-set-user-password`) -- todos os fluxos acima (API keys CRUD + expiração, propagação de `plan_tier`, uso diário, webhooks via conta, mcp-info) exercitados ponta a ponta contra o servidor real, não só testes unitários mockados. Dados de teste extras revogados/revertidos ao final (chaves de teste revogadas, `plan_tier` restaurado a `starter`, filtro de teste deletado).
- **Não testado ao vivo**: IDOR entre DOIS clientes Cognito diferentes nas rotas de API keys/webhooks via conta (só havia 1 usuário de teste confirmado no User Pool) -- coberto por teste unitário formal (`api-keys.service.test.ts`, `getOwnedApiKey` rejeitando `customer_id` divergente) e pela mesma garantia estrutural já usada no resto do projeto (chave composta em `SavedFilters`, comparação explícita de `customer_id` em `api-keys.service.ts`).

### 🆕 Dashboard v2 (frontend): redesign completo consumindo as rotas novas (2026-09-07)

Fecha a pendência "próximo agente (frontend)" da seção anterior. `frontend/src/app/pages/dashboard/` foi **reescrito por completo** pra consumir as rotas de múltiplas API keys, uso diário e webhooks/MCP via conta que o backend acabou de expor. Não tocou `backend/` (nenhum arquivo), nem `pages/landing`, `pages/login`, `pages/payment` (mantidos intactos).

**Estrutura nova:**
- `core/account.service.ts` -- reescrito: mantém `provision`/`getMe`/`getUsage`/`checkout`/`getSubscription`, **remove** `regenerateApiKey()` (rota `POST /v1/account/api-key/regenerate` foi removida pelo backend), e adiciona `getDailyUsage`, `listApiKeys`/`createApiKey`/`updateApiKey`/`revokeApiKey`, `listWebhooks`/`createWebhook`/`updateWebhook`/`deleteWebhook`/`testWebhook`/`reactivateWebhook`/`regenerateWebhookSecret`, `getMcpInfo`. `justProvisionedApiKey` (signal) agora também é setado por `createApiKey()`, não só `provision()` -- o banner "copie agora" do topo do dashboard funciona pra qualquer chave nova, não só a primeira.
- `core/http-error.util.ts` -- novo, `extractErrorMessage(err, fallback)` extraído do padrão que já existia (duplicado) em `payment.ts`, reusado pelos componentes novos do dashboard (`payment.ts` não foi tocado, continua com sua própria cópia local -- risco zero de regressão numa tela já testada e funcionando).
- `pages/dashboard/dashboard.ts/html/scss` -- reescrito como orquestrador fino: carrega `account`+`usage`+`daily` em paralelo (`Promise.all`, mesmo padrão de antes) e passa pra sub-componentes; mantém o banner de "nova chave, copie agora" e a mensagem de "pagamento confirmado" (`?upgraded=1`) exatamente como na v1.
- `pages/dashboard/components/` (novo diretório, 8 componentes standalone, todos usando a API de signals `input()`):
  - `account-card/` -- card pequeno (email, badge de plano, botão upgrade/alterar plano).
  - `usage-card/` -- card grande: resumo + barra de progresso do uso mensal, e dentro dele os dois gráficos abaixo.
  - `daily-usage-chart/` -- **gráfico de barras empilhadas em SVG puro** (sem lib nenhuma), 30 dias, REST (navy) empilhado com MCP (gold), grid de referência, `<title>` nativo por barra como tooltip, eixo X rotulado a cada 5 dias.
  - `rest-mcp-chart/` -- **donut chart em SVG puro** (trick de `stroke-dasharray`/`stroke-dashoffset` em dois `<circle>`), mostra `totalRest`/`totalMcp` com percentual no centro, estado vazio tratado ("Ainda sem chamadas registradas.").
  - `api-keys-table/` -- seção full-width: form de criação (nome + expiração opcional via `<input type=date>`), tabela (nome/criada em/expira em/status/ações), edição inline (renomear + mudar expiração via `PATCH`), revogação com confirmação inline (mesmo padrão UX que a v1 já usava pra "regenerar chave").
  - `webhooks-table/` -- seção full-width: form de criação (nome opcional, UF via `<select>`, modalidade via `<input>` + `<datalist>` com sugestões comuns do PNCP, keyword opcional, URL), tabela com edição inline, testar (mostra resultado do teste inline, sucesso ou falha), reativar (só aparece quando desativado por circuit breaker), regenerar secret (confirmação), excluir (confirmação).
  - `mcp-panel/` -- URL do MCP com botão copiar + grid das 8 ferramentas com descrição (fonte única: `GET /v1/account/mcp-info`, mesmo texto que o servidor MCP real usa).
  - `docs-panel/` -- CTA simples pro Swagger UI (`${apiUrl}/docs`, nova aba).
- `styles.scss` (global) -- ganhou um bloco novo de classes reusadas pelas 4 seções "caixa grande" (`panel-wide`, `panel-head`, `data-table`, `status-dot`/`status-active`/`status-inactive`/`status-warning`, `confirm-inline`, `inline-form`, `btn-xs`, `form-input-sm`, `text-truncate`) -- evita duplicar o mesmo CSS de tabela/form/confirmação em 4 componentes diferentes, mesma filosofia de reuso que já existia pra `.btn`/`.card`/`.badge`.

**Decisão de design (gráficos):** SVG inline feito à mão, sem `chart.js` nem nenhuma lib -- só 2 gráficos simples (barra empilhada + donut), a mesma filosofia de "zero dependência pesada à toa" que já levou a escolher `amazon-cognito-identity-js` puro em vez de Amplify. Paleta reusa os tokens já existentes do design system (`--color-navy-700` pra REST, `--color-gold-500` pra MCP) -- consistente com o resto do produto, e o par azul/dourado tem contraste de matiz suficiente pra não depender só de cor pra diferenciar as duas séries.

**Testado AO VIVO** (Cognito real + backend real + DynamoDB Local real, via Chrome DevTools MCP, `ng serve --port 4201` -- processo já estava de pé de uma sessão anterior, reaproveitado; backend já rodando na 3000 com `FRONTEND_ORIGIN=http://localhost:4201`):
- Login com o usuário de teste (senha resetada via `aws cognito-idp admin-set-user-password --profile LicitaHawk`, a sessão anterior tinha expirado) -- dashboard carregou com dados reais de rodadas de teste anteriores: 5 API keys pré-existentes, uso mensal `6/5000`, gráfico diário e donut já preenchidos com dado real (`REST 5 / MCP 1`, 83%/17%), 8 tools do MCP, link de documentação.
- **API keys, ciclo completo**: criar chave nova ("Chave de teste dashboard v2") -- banner "copie agora" apareceu com a chave crua, `POST /v1/account/api-keys` real; revogar essa mesma chave com confirmação inline -- status mudou pra "Revogada", botões desabilitados; renomear uma chave ativa existente (campo vazio -- dado legado pré-multi-key -- para um nome novo) via `PATCH`, refletido na tabela sem reload.
- **Webhooks, ciclo completo**: criar (`uf:GO`, `modalidade:Pregão - Eletrônico`, `keyword:informática`, `webhook_url:http://127.0.0.1:9999/hook-teste`) -- 201 real; testar -- **confirmado que o SSRF guard real bloqueou** (`consecutive_failures` foi de 0 pra 1 no circuit breaker de verdade, não mock); editar nome e URL via `PATCH`; regenerar secret (confirmação); excluir (confirmação) -- lista voltou a "Nenhum webhook criado ainda.".
- **Circuit breaker + reativação** (fluxo que a v1 nunca tinha exercitado): criado um 2º webhook (`uf:SP`, `modalidade:Concorrência`, URL inválida de propósito) e clicado "Testar" 5 vezes seguidas -- na 5ª falha o circuit breaker real desativou o filtro automaticamente (`DEFAULT_MAX_CONSECUTIVE_FAILURES=5`), a UI mudou pra "Desativado (circuit breaker)" e o botão "Reativar" apareceu; clicado "Reativar" -- `POST .../reactivate` real, voltou pra "Ativo" com contador zerado, botão "Reativar" sumiu. Webhook de teste excluído ao final.
- **Documentação**: clique no CTA abriu `http://localhost:3000/docs/` em nova aba, confirmado Swagger UI real carregado (`list_pages` do Chrome DevTools MCP mostrou a aba nova com título "Swagger UI").
- **Responsividade**: viewport mobile (390px) -- grid conta/uso empilhou em coluna única, cards mantiveram largura total, gráficos legíveis.
- **Console/erros**: zero erros de console durante todo o fluxo -- só um aviso de acessibilidade do Chrome DevTools (`A form field element should have an id or name attribute`, 4 ocorrências) nos inputs de edição inline das tabelas; não afeta funcionalidade, anotado como limitação menor abaixo.
- `npx ng build`: limpo -- só os 3 warnings CommonJS já conhecidos e inofensivos do `amazon-cognito-identity-js` (`buffer`, `@aws-crypto/sha256-js`, `isomorphic-unfetch`), sem erro, sem warning novo introduzido pelo dashboard.

**Limitações conhecidas / não testado:**
- Aviso leve de acessibilidade do Chrome DevTools sobre 4 campos de formulário sem `id`/`name` explícito nos modos de edição inline (`api-keys-table`/`webhooks-table`) -- os campos já têm `name` via `ngModel`, o linter provavelmente quer também `id` associado a um `<label>`; não corrigido nesta rodada por ser puramente cosmético/a11y, sem impacto funcional.
- Não foi testado IDOR entre dois clientes Cognito diferentes na UI (mesma limitação já documentada no lado backend -- só 1 usuário de teste confirmado no User Pool).
- Não foi criado um segundo usuário pra testar o `PLAN_LIMIT_EXCEEDED` (limite de filtros/plano Free sem webhook) na UI -- a rota já tem 6 testes unitários no backend cobrindo esse caminho; o tratamento de erro genérico (`extractErrorMessage`) exibiria a mensagem do backend corretamente, mas não foi clicado ao vivo.

### 🐛 Bug real achado pelo usuário: modalidade era texto livre na criação de webhook (2026-09-07)

Usuário notou (testando o dashboard v2) que o campo "modalidade" no formulário de criar webhook era um input de texto livre (com sugestões via `<datalist>`), diferente do resto dos campos com valor fixo (UF já era `<select>`). Investigado e confirmado como **bug real, não só falta de polish**: `tender-matcher.adapter.ts` faz `Query` na GSI `uf+modalidade` com **igualdade EXATA de string** contra `Tender.modalidade` (que grava o `modalidadeNome` cru retornado pelo PNCP, ex. `"Pregão - Eletrônico"`). Qualquer valor digitado que não batesse caractere por caractere com o nome real do PNCP criava um webhook que **nunca dispararia, silenciosamente, para sempre** — nenhum erro, nenhum aviso, só um filtro morto.

**Descoberta da lista oficial**: a OpenAPI de consulta do PNCP não lista os valores (já documentado nas Notas de Execução), mas existe um endpoint de domínio separado, `GET https://pncp.gov.br/api/pncp/v1/modalidades`, que devolve os 19 códigos oficiais (1-15 nacionais + 16-19 internacionais, adicionados depois do que as Notas de Execução originais registravam). Confirmado contra os dados reais já ingeridos (Scan em `Tenders`, 9 valores distintos observados) — todos batem exatamente com os nomes desse domínio oficial.

**Corrigido:**
- `backend/src/common/modalidades.ts` (novo): lista canônica dos 15 códigos nacionais (1-15 — os 16-19 internacionais ficam de fora de propósito, já que a ingestão nunca cobriu eles, incluir criaria a mesma armadilha ao contrário).
- `POST /v1/account/webhooks` agora **valida** `modalidade` contra essa lista (400 `VALIDATION_ERROR` com a lista de valores aceitos na mensagem) — defesa no backend, não só na UI, pra qualquer cliente que bata direto na rota.
- `frontend/.../webhooks-table`: campo trocado de `<input list="...">` pra `<select>` com as 15 opções.
- **Decisão de escopo**: `GET /v1/tenders?modalidade=` (Fase 3, API pública por API key) continua texto livre de propósito — é busca, não criação de filtro que precisa bater exato; não mexi nesse contrato existente sem mais contexto.

**Testado ao vivo**: `tsc`/`npm test` (279/279, sem quebrar nada), `ng build` limpo, e via `curl` direto contra o backend real — modalidade fora da lista → 400 com a lista de valores aceitos; modalidade exata (`"Pregão - Eletrônico"`) → 201 criado com sucesso (dado de teste removido depois).

### 🔌 Porta do backend mudou de 3000 para 3577 (2026-09-07)

Durante o teste acima, a porta 3000 foi ocupada por outro projeto do usuário nesta máquina (processo `dist/main.js` — mesmo tipo de colisão que já tinha acontecido com a porta 4200 do frontend, resolvida indo pra 4201). Backend do licitahawk agora sobe em **3577** (porta dedicada, evita esse choque de novo): `PORT=3577 FRONTEND_ORIGIN=http://localhost:4201 npx tsx src/server.ts`. `frontend/src/app/config.ts::APP_CONFIG.apiUrl` atualizado pra `http://localhost:3577`.

### 🆕 Playground (backend): busca/detalhe/webhook-preview via Cognito, contando pro plano real do cliente (2026-09-07)

Backend do "Playground" do dashboard — uma UI onde o cliente usa a API de verdade (busca de licitações, detalhe, "ver um webhook chegando na tela") sem escrever código nem colar a própria API key (ela só é mostrada 1x na criação, por design). As rotas novas são autenticadas por Cognito (não API key), mas contam pro MESMO limite/uso do plano do cliente — é a API real dele sendo usada, só que disparada pela nossa UI em vez de `curl`. Não tocou `src/billing/nfse-payload.ts`, Fase 7/8, o dispatcher de webhook real nem o SSRF guard (`webhook/`).

**1. Middleware de enforcement generalizado (`src/common/client-rate-limit.ts`)**: extraído o núcleo do antigo `clientRateLimit` em duas funções reusáveis, sem duplicar lógica:
- `enforceUsage(customerId, planTier, surface: "rest"|"mcp")` — recebe `customerId`/`planTier` diretamente (sem depender de `req.auth`), aplica o mesmo rate limit por minuto (`ClientRateLimits`) e, se passou, incrementa a mesma quota mensal (`incrementAndCheckMonthlyUsage`) + uso diário (`incrementDailyUsage`). Devolve `{ limit, count, rateLimited, monthly? }` (`monthly` ausente quando `rateLimited:true` — o incremento mensal nunca roda nesse caso, mesma regra da Rodada 7).
- `respondIfUsageExceeded(res, result, planTier)` — aplica os headers `X-RateLimit-*` e, se aplicável, já envia o 429 (`RATE_LIMITED` ou `PLAN_LIMIT_EXCEEDED`); devolve `boolean` (resposta já enviada ou não).
- `clientRateLimit` (rotas de API key) foi reescrito por cima dessas duas funções — comportamento idêntico ao anterior, sem mudança de contrato (headers/formato de erro iguais).
- Novo `enforceUsageForCognitoAccount` (`src/account/account-playground.router.ts`) — equivalente Cognito de `authenticate`+`clientRateLimit` juntos: resolve `plan_tier` via `findAccountByCustomerId(req.cognitoUser.sub)` (404 `ACCOUNT_NOT_PROVISIONED` se a conta não existe), chama `enforceUsage(..., "rest")` (é literalmente a mesma busca REST) e `respondIfUsageExceeded`.

**2. Rotas novas — `src/account/account-playground.router.ts`, montado em `/v1/account/playground`** (registrado em `server.ts`). Todas com `cognitoAuthenticate` + `enforceUsageForCognitoAccount`:

- **`GET /v1/account/playground/tenders`** — proxy pra busca real. Reusa `parseSearchQuery` (agora exportada de `tenders.router.ts`) e `searchTenders` (`tenders.service.ts`) — mesmos params/validação de `GET /v1/tenders` (`uf`, `modalidade`, `keyword`, `valorMin`/`valorMax`, `dataInicial`/`dataFinal`, `sort`, `cursor`, `limit`), mesmo formato de resposta (`{ data: Tender[], next_cursor? }`). **Diferença deliberada**: `modalidade` (multi-valor) é validada contra `src/common/modalidades.ts` (`assertValidModalidadeNome`, nova função ali) — 400 `VALIDATION_ERROR` com a lista de valores aceitos se não bater exatamente com o domínio oficial do PNCP (mesmo raciocínio do fix de webhook: `GET /v1/tenders` mantém texto livre de propósito por ser busca, mas o Playground reforça o mesmo critério estrito de `POST /v1/account/webhooks`).
- **`GET /v1/account/playground/tenders/:id`** — proxy pro detalhe (`getTenderById`), mesmo shape de `GET /v1/tenders/:id`. 404 `NOT_FOUND` se não existe.
- **`GET /v1/account/playground/webhook-preview`** — **não é um webhook de verdade** (não passa pelo SSRF guard/dispatcher). Nova função `findRecentlyUpdatedMatches` (`tenders.service.ts`): reusa a mesma correspondência EXATA uf+modalidade do matcher real (`tender-matcher.adapter.ts`) + `matchesKeyword` (keyword opcional), consultando `Tenders` via `GSI1-uf-data_publicacao` (não existe GSI uf+modalidade em `Tenders`, só em `SavedFilters` — a igualdade de modalidade é filtrada em memória sobre um teto de leitura de 200 itens por chamada, limitação documentada no código: um tender atualizado recentemente mas publicado há muito tempo pode ficar fora do teto). Aceita `since` (ISO opcional) — só devolve tenders com `data_atualizacao > since`. Resposta `{ data: { tenders: Tender[], since } }`, ordenada por `data_atualizacao` desc, `since` = timestamp mais recente encontrado (ou o `since` de entrada ecoado de volta, se nada novo foi encontrado) — o frontend manda esse valor na próxima chamada. Documentado no código que isso é honesto sobre ser polling (ingestão real a cada ~15min), não push em tempo real.

**Testado:**
- `npx tsc --noEmit` limpo. `npm test`: **304/304 testes passando** (279 herdados + 25 novos: `enforceUsage`/`respondIfUsageExceeded` em `client-rate-limit.test.ts`, `findRecentlyUpdatedMatches` num `tenders.service.test.ts` novo — 1º teste unitário desse arquivo, que antes só tinha cobertura via teste ao vivo — e `account-playground.router.test.ts` novo cobrindo `enforceUsageForCognitoAccount` + as 3 rotas).
- **Ao vivo, real, backend reiniciado com o código novo na porta 3577 (`PORT=3577 FRONTEND_ORIGIN=http://localhost:4201`) + DynamoDB Local real**: login real via Cognito (`initiate-auth`/`USER_PASSWORD_AUTH`, `teste@licitahawk.local`/`SenhaTeste123`) contra o usuário de teste já provisionado (plano Starter). Confirmado com dado real do PNCP (não mock): `GET .../tenders?uf=GO` devolveu tenders reais de Goiás com `next_cursor`; `modalidade=texto-qualquer` → 400 com a lista de 15 valores aceitos; `GET .../tenders/:id` (url-encoded) → 200 com o tender certo, id inexistente → 404; `GET .../webhook-preview?uf=GO&modalidade=Pregão - Eletrônico` devolveu tenders reais + `since`; chamando de novo com esse `since` → 0 tenders novos (nada mudou, comportamento esperado); `uf`/`modalidade` ausentes → 400; sem token → 401. Headers `X-RateLimit-Limit: 180`/`X-RateLimit-Remaining` confirmados em toda resposta (plano Starter). **`GET /v1/account/usage` antes (6 requisições) e depois (14, após 8 chamadas ao Playground) confirmou o incremento mensal real** — a prova de que o Playground conta pro mesmo limite do plano, não é um caminho paralelo que fura a quota.
- **Não testado ao vivo**: 404 `ACCOUNT_NOT_PROVISIONED` (exigiria criar/descartar um 2º usuário Cognito sem conta provisionada só pra esse caso) — coberto por teste unitário determinístico em `account-playground.router.test.ts`.

**Contrato pro próximo agente (frontend Angular do Playground):**
```
GET /v1/account/playground/tenders?uf=&modalidade=&keyword=&valorMin=&valorMax=&dataInicial=&dataFinal=&sort=&cursor=&limit=
  → 200 { data: Tender[], next_cursor? }   (mesmo shape de GET /v1/tenders)
  → 400 VALIDATION_ERROR (inclui modalidade fora do domínio oficial do PNCP)
  → 404 ACCOUNT_NOT_PROVISIONED
  → 429 RATE_LIMITED | PLAN_LIMIT_EXCEEDED
  headers: X-RateLimit-Limit, X-RateLimit-Remaining

GET /v1/account/playground/tenders/:id   (id = pncp_control_number, url-encode a barra: %2F)
  → 200 { data: Tender }
  → 404 NOT_FOUND | ACCOUNT_NOT_PROVISIONED

GET /v1/account/playground/webhook-preview?uf=&modalidade=&keyword=&since=
  uf e modalidade OBRIGATÓRIOS (modalidade contra o domínio oficial, ver <select> de POST /v1/account/webhooks)
  → 200 { data: { tenders: Tender[], since } }   -- mande o `since` recebido na próxima chamada
  → 400 VALIDATION_ERROR (uf/modalidade ausentes/inválidos, since não-ISO)
  → 404 ACCOUNT_NOT_PROVISIONED
```
Todas as 3 rotas: header `Authorization: Bearer <idToken>` do Cognito (mesmo padrão das outras rotas de `/v1/account/*`).

### 🆕 Frontend: tooltip global, shell (sidebar+topbar) e Playground (2026-09-07)

Fecha as 4 pendências do frontend (tooltip de ajuda, formulário de webhook melhorado, shell com sidebar/topbar, e a página Playground consumindo as 3 rotas novas do backend). Não tocou `backend/` (nenhum arquivo).

**1. `app-help-tooltip` (`frontend/src/app/shared/help-tooltip/`)** — portado de um padrão já existente em outro projeto do usuário, adaptado. **Decisão de design: CSS puro, sem `@angular/cdk`** (o projeto não tinha essa dependência e a Parte 1 pedia tentar CSS puro primeiro) — posicionamento calculado via `getBoundingClientRect()` do trigger no `open()`, painel em `position: fixed` com flip vertical (acima/abaixo conforme espaço disponível) e clamp horizontal (nunca vaza da viewport, margem de 8px), recalculado em `window:resize`. Ícone "?" é um SVG inline (`<circle>`+`<text>`), sem lib de ícone nova. API: `[text]` pra texto simples ou `<ng-content>` pra conteúdo rico, `[ariaLabel]`, `[panelWidth]`.

**2. Tooltips aplicados + formulário de webhook expandido:**
- `mcp-panel`/`webhooks-table`: parágrafo de descrição abaixo do título virou `<app-help-tooltip>` ao lado do `<h2>` (classe `.panel-title-row` nova em `styles.scss`, reusada pelas duas).
- `webhooks-table`: cada label do formulário de criação (Nome, UF, Modalidade, Palavra-chave, URL) ganhou um tooltip com exemplo concreto pensado pra alguém não-técnico (ex.: URL → "O endereço do seu sistema que vai receber o aviso... Exemplo: https://meusite.com/webhooks/licitacoes").
- Formulário de criação virou um card expandido (`.webhook-form`, novo em `webhooks-table.scss`) em vez do `inline-form` comprimido: layout em coluna com uma grade 2-colunas só pra UF+Modalidade, e Nome/Palavra-chave/URL em linha inteira. Campo de palavra-chave ganhou classe `.form-input-lg` (padding/fonte maiores) — decisão: continua `<input>` (não `<textarea>`), já que semanticamente é um termo/frase única, só visualmente maior, conforme a orientação do lead.
- `UFS`/`MODALIDADES` extraídos pra `frontend/src/app/common/{ufs,modalidades}.ts` (antes viviam só como const local em `webhooks-table.ts`) — reusados pela Parte 4 (Playground) sem duplicar a lista.

**3. Shell (`frontend/src/app/shell/app-shell.ts`)** — sidebar colapsável (navy/gold, ícones SVG inline, sem lib nova) com **Playground** (padrão/primeiro) e **Configurações** (segundo), email do usuário + logout fixados embaixo; topbar mostra o título da rota ativa (via `route.data.title`). **Rotas reestruturadas** (`app.routes.ts`): `/dashboard` foi substituída por `/app` (guardado por `authGuard`, um guard só protege as duas rotas filhas) com filhos `/app/playground` (novo, default) e `/app/settings` (o dashboard antigo inteiro — `account-card`, `usage-card`, gráficos, `api-keys-table`, `webhooks-table`, `mcp-panel`, `docs-panel` — remontado ali sem reescrever nenhum desses componentes). `login.ts`/`payment.ts`/`payment.html` atualizados pra redirecionar pro shell (`/app/playground`, `/app/settings`) em vez de `/dashboard`. `dashboard.html`/`.ts`/`.scss` perderam o wrapper de topbar/logout próprio (o shell já provê isso) e viraram conteúdo puro montado dentro de `<router-outlet>`.

**4. Página Playground (`frontend/src/app/pages/playground/`)** — 4 sub-componentes standalone:
- `components/search-panel/` — formulário completo (UF multi-select, modalidade multi-select, palavra-chave, faixa de valor, faixa de data, ordenação) → `GET /v1/account/playground/tenders` → tabela de resultado com paginação via `next_cursor` ("Carregar mais") → clique na linha emite `pncp_control_number` pro pai. Toggle "Ver como isso funciona via API" mostra o `curl` equivalente contra a rota REAL (`GET /v1/tenders`, sub-componente `curl-preview/` reusável).
- `components/tender-detail/` — modal de detalhe, carrega via `GET /v1/account/playground/tenders/:id` (signal `input.required<string>()`, recarrega via `effect()` quando o id muda).
- `components/monitor-panel/` — "Ver um webhook chegando na tela": mesmos critérios de um webhook real (UF, modalidade, palavra-chave opcional), botão "Começar a monitorar" dispara a 1ª chamada a `GET /v1/account/playground/webhook-preview` e depois faz polling a cada 25s passando o `since` da resposta anterior; licitações novas entram no topo de uma lista "ao vivo" com badge "novo" (destaque visual por 4s), contador "X encontrada(s) desde que você começou a monitorar". Texto da UI é honesto sobre ser polling (~25s aqui, ingestão real do PNCP a cada ~15min), não push de verdade.
- `core/account.service.ts` ganhou `playgroundSearchTenders`/`playgroundGetTender`/`playgroundWebhookPreview` + tipos (`Tender`, `PlaygroundSearchParams`, `PlaygroundSearchResult`, `WebhookPreviewParams/Result`).
- **Decisão de UX**: a busca real (`GET /v1/tenders`, e por extensão `GET /v1/account/playground/tenders`) exige `uf` OU `modalidade`, nunca os dois juntos (são GSIs distintos no DynamoDB, ver `tenders.service.ts`) — descoberto ao vivo (erro 400 real ao testar com os dois preenchidos). Em vez de restringir a UI, foi adicionado um aviso inline explicando a restrição antes do usuário errar, e o erro real do backend (que já é claro) continua servindo de reforço reativo se mesmo assim acontecer.

**3 bugs reais encontrados e corrigidos durante o teste ao vivo (nenhum estava óbvio por leitura de código):**
1. **[MÉDIO] `AppShell` quebrava a ativação da rota inteira com `TypeError: Cannot read properties of undefined (reading 'data')`** — o campo `pageTitle` chamava `this.deepestTitle()` de forma síncrona no próprio inicializador (`startWith(this.deepestTitle())` + `{ initialValue: this.deepestTitle() }`), mas nesse instante da construção do componente a navegação pra rota filha (lazy, via `loadComponent`) ainda está em andamento e `this.route.firstChild.snapshot` ainda não existe — o acesso a `.data` sem guarda nesse `snapshot` undefined derrubava a criação do componente inteiro, e como a UI updateStrategy do Router é `deferred`, o efeito visual era a navegação inteira "falhar silenciosamente" (URL voltava pra `/login`, tela em branco, **nenhum erro no console do usuário final** — só apareceu no log do próprio dev server/stdout do Vite). Corrigido: removida a chamada síncrona no inicializador (`initialValue: ''`), o signal `pageTitle` só é populado reativamente a partir do primeiro `NavigationEnd` (que dispara logo em seguida, já com tudo resolvido), e `deepestTitle()` ganhou guarda extra (`r?.snapshot?.data?.['title']`).
2. **[MÉDIO] `NG0701: Missing locale data for the locale "pt-BR"` fazia a coluna "Valor estimado" (e o campo homônimo no modal de detalhe) renderizar vazia, silenciosamente, em toda linha da tabela de busca** — `CurrencyPipe` com `'pt-BR'` explícito (`valor_estimado | currency:'BRL':'symbol':'1.2-2':'pt-BR'`) precisa da locale registrada via `registerLocaleData`, que o projeto nunca tinha feito (nenhum componente anterior usava `CurrencyPipe` com locale explícito). Corrigido em `main.ts`: `registerLocaleData(localePtBr, 'pt-BR')` — `@angular/common/locales/pt` é o arquivo certo (Angular não tem um arquivo `pt-BR` separado; a variante brasileira É a `pt` base, `pt-PT` é que tem arquivo próprio), registrado sob o id `'pt-BR'` que os pipes já referenciavam.
3. **[BAIXO, responsividade] Sidebar do shell cortava texto feio em viewport estreito (≤720px)** — a media query encolhia a coluna da sidebar pra 60px via CSS, mas o conteúdo (nome "LicitaHawk", email, labels de nav, "Sair") continuava tentando renderizar por extenso porque o signal `sidebarExpanded()` (que controla se esses `<span>`s existem no DOM) é independente da media query CSS. Corrigido escondendo esses elementos via `display: none` na mesma media query (`shell-brand-name`, `shell-user-email`, `shell-nav-item span`), sem tocar a lógica JS de expand/collapse (que continua funcionando normalmente em telas largas).

**Testado AO VIVO** (Cognito real + backend real na porta 3577 + DynamoDB Local real, via Chrome DevTools MCP; dev server reiniciado limpo em `--port 4201` porque o processo anterior da sessão estava servindo um bundle desatualizado, sem os componentes novos, mascarado como página em branco):
- Login com usuário de teste → redireciona pro shell (`/app/playground`), sidebar mostrando "LicitaHawk"/Playground ativo em destaque dourado/email real (`teste@licitahawk.local`, não o `sub` do Cognito — corrigido buscando via `GET /v1/account/me` em vez de `authService.currentEmail`, que aqui é o username do Cognito = UUID, não o email).
- **Busca real**: UF=GO → 20 resultados reais do PNCP (`COMANDO DA AERONAUTICA`, `PLANALTO SOLAR PARK S.A.`, etc.), valores em R$ formatados corretamente após o fix da locale, "Carregar mais" funcional.
- **Detalhe**: clique numa linha abriu o modal com todos os campos reais (objeto, CNPJ, UF/município, modalidade, situação, valor, datas, link pro PNCP real).
- **`curl` de exemplo**: toggle "Ver como isso funciona via API" gerou `curl -H "Authorization: Bearer SUA_API_KEY" "http://localhost:3577/v1/tenders?uf=GO&sort=desc&limit=20"` — sintaticamente correto e batendo com os parâmetros escolhidos.
- **Monitoramento ao vivo**: UF=GO + modalidade=Pregão-Eletrônico → "Começar a monitorar" → 1ª chamada real a `webhook-preview` (200, `0 encontrada(s)`, comportamento esperado já que `since` = agora) → "Parar" encerrou o polling sem erro.
- **Configurações**: navegação entre Playground/Configurações funcional, tooltips do título (Webhooks/MCP) e de cada campo do formulário de webhook testados (hover funciona; clique/foco também abre — importante pra acessibilidade via teclado), formulário expandido testado criando um webhook de verdade (`GO`/`Pregão - Eletrônico`/keyword `"teste ux"`/URL `127.0.0.1:9999`) — apareceu na tabela corretamente, depois excluído (dado de teste limpo).
- **Responsividade**: viewport 390×844 (mobile) — sidebar colapsa pra ícone-só sem cortar texto (após o fix #3), cards empilham em coluna única, tooltip clampado corretamente perto da borda direita da tela (testado no campo "Palavra-chave" do form de webhook).
- **Guard/logout**: logout limpa sessão e redireciona pra `/login`; navegação direta pra `/app/playground` sem sessão redireciona pro `/login` (guard funcionando na rota pai, cobrindo as duas filhas).
- **Console**: zero erros/warnings após os 3 fixes acima (antes deles, os 2 primeiros bugs geravam either uma tela em branco silenciosa ou um `NG0701` real no console).
- `npx ng build`: limpo — só os 3 warnings CommonJS já conhecidos e inofensivos do `amazon-cognito-identity-js`, sem erro, sem warning novo.

**Não testado ao vivo** (mesma cautela de outras rodadas — ação de baixo valor/alto risco de sujeira de dado, ou exigiria esperar ~15min pela ingestão real):
- Uma licitação nova de verdade aparecendo na lista "ao vivo" do monitoramento durante os ~25s de uma sessão de teste (a ingestão real roda a cada ~15min; o texto da UI já avisa isso). O caminho de "achou 1+ tenders" foi coberto por leitura de código (mesma função `findRecentlyUpdatedMatches` já testada ao vivo pelo backend, ver seção anterior) e pela evidência de que a 1ª chamada (0 resultados, `since=agora`) funcionou ponta a ponta sem erro.
- `PLAN_LIMIT_EXCEEDED`/`ACCOUNT_NOT_PROVISIONED` na UI do Playground (exigiria um 2º usuário Cognito sem conta provisionada) — coberto por teste unitário formal no backend (seção anterior).

### 🆕 Correção de rumo: uso diário em 4 categorias (API/MCP/UI/Webhook) + feed real de entregas (backend) (2026-09-07)

Fecha a pendência de o "Playground" ter virado o Dashboard de verdade (frontend, próximo agente) — o rastreamento de uso diário precisava distinguir 4 origens em vez de 2. Antes: `rest`/`mcp`, e o uso pela nossa própria UI (Playground/Dashboard, autenticado por Cognito) era contado incorretamente como `rest`, igual a uma chamada via API key de verdade. Não tocou `src/billing/nfse-payload.ts` (Seção 12, fechada), Fase 7/8, nem o SSRF guard/dispatcher em si além da instrumentação mínima abaixo.

**1. Schema `UsageDaily` expandido de 2 pra 4 campos** (`src/common/usage-daily.repository.ts`): `rest_count`/`mcp_count` → `api_count`/`mcp_count`/`ui_count`/`webhook_count`. `UsageKind` (tipo do parâmetro de `incrementDailyUsage`) virou `"api" | "mcp" | "ui" | "webhook"` (era `"rest" | "mcp"`). Nenhuma migração de dado necessária — `UsageDaily` tem TTL de 60 dias, os campos novos simplesmente aparecem zerados via `?? 0` pros itens antigos que só tinham `rest_count`/`mcp_count` (esses ficam órfãos até expirar pelo TTL, sem quebrar nada).

**2. Tag de surface corrigida em cada ponto de incremento:**
- `src/common/client-rate-limit.ts::clientRateLimit` (rotas autenticadas por API KEY, incluindo `/mcp`): `req.path === "/mcp" ? "mcp" : "api"` (era `"rest"`) — são chamadas via API key de verdade, por isso `"api"`, não mais o nome ambíguo `"rest"`.
- `src/account/account-playground.router.ts::enforceUsageForCognitoAccount` (rotas do Dashboard/ex-Playground, autenticado por Cognito): `enforceUsage(customerId, plan_tier, "ui")` (era `"rest"`) — **achado principal desta rodada**: uso pela nossa própria UI agora aparece separado do uso via API key real.
- **Novo**: `webhook_count` incrementado nos 2 pontos reais de ORIGEM de um disparo de webhook — `src/webhook/tender-matcher.adapter.ts::LocalTenderMatcherAdapter.emit()` (1x por filtro casado, antes do `enqueue` fire-and-forget) e `src/webhook/webhook-test-dispatch.ts::dispatchTestWebhook()` (1x por chamada de `POST .../webhooks/:id/test`). **Decisão de design**: o incremento fica na origem (quem decide que uma entrega deve ser tentada), não dentro de `InMemoryWebhookQueueAdapter.enqueue()`/`attemptDelivery` — assim as até 3 tentativas de retry com backoff de uma mesma entrega (`in-memory-webhook-queue.adapter.ts`) contam como 1 uso do recurso, não 3, e o reenfileiramento de recuperação pós-crash (`webhook-queue-recovery.ts`, que chama `enqueue()` de novo pro MESMO job órfão) não duplica a contagem, já que não passa pelos 2 pontos de origem instrumentados.

**3. Agregação e contrato da rota `GET /v1/account/usage/daily` atualizados** (`src/account/account.service.ts::getAccountDailyUsage`, `docs/openapi.yaml`, versão `0.6.0`→`0.7.0`):
```
GET /v1/account/usage/daily  (CognitoAuth)
  → 200 {
      data: {
        days: [{ date, api_count, mcp_count, ui_count, webhook_count, total_count }]  // 30 itens, mais antigo→mais recente, zero-preenchido
        totals: { api, mcp, ui, webhook }
      }
    }
```
(era `totalRest`/`totalMcp` soltos — virou objeto `totals` com as 4 chaves, mais extensível pro frontend.)

**4. Nova rota `GET /v1/account/webhooks/:id/deliveries`** (`src/account/account-webhooks.router.ts`, CognitoAuth): feed de entregas REAIS do webhook do cliente (não a simulação de `GET /v1/account/playground/webhook-preview`). Reusa `listDeliveriesForOwnedFilter` (`src/filters/filters.service.ts`) — mesma função já usada por `GET /v1/filters/:id/deliveries` (API key) — só troca de onde vem o `customer_id` (`req.cognitoUser.sub`), mesmo padrão de todo o resto do router. `→ 200 { data: [...] }` (mesmo shape do endpoint por API key), `→ 404 NOT_FOUND` (filtro não encontrado ou pertence a outro customer — IDOR).

**Testado:**
- `npx tsc --noEmit` limpo. `npm test`: **312/312 testes passando** (304 herdados, todos ajustados de `rest_count`/`totalRest` pros nomes novos + 8 novos: `ui`/`webhook` em `usage-daily.repository.test.ts`, `tender-matcher.adapter.test.ts` novo — 1º teste unitário desse arquivo, cobrindo incremento por filtro casado/inativo/keyword não batendo/múltiplos candidatos — e `webhook-test-dispatch.test.ts` novo).
- **Ao vivo, real, backend reiniciado com o código novo na porta 3577 + DynamoDB Local real**: ID token real via `aws cognito-idp initiate-auth` (usuário de teste `teste@licitahawk.local`). `GET .../playground/tenders?uf=GO` real → confirmado `ui_count` foi de 0 pra 1 e `api_count` continuou 0 (não confundido com API key) via `GET /v1/account/usage/daily` antes/depois. Criado webhook real (`uf:GO`, `modalidade:"Pregão - Eletrônico"`, `webhook_url:127.0.0.1:9999`) → `POST .../test` → **confirmado `webhook_count` foi de 0 pra 1** (SSRF guard real bloqueou o IP privado, log real `[webhook-queue] disparo bloqueado por SSRF`, e mesmo assim contou — bloqueado também é tentativa real, por design). `GET .../webhooks/:id/deliveries` devolveu a entrega real (`success:false`, `error:"IP resolvido bloqueado..."`, `attempts:1`). Dado de teste (filtro) deletado ao final; backend deixado rodando (porta 3577, `FRONTEND_ORIGIN=http://localhost:4201`) pros demais agentes da sessão.
- **Não testado ao vivo**: um disparo de webhook real via `tender-matcher.adapter.ts` (a ingestão real casando um filtro salvo com um tender novo) — coberto pelos 4 testes unitários novos de `tender-matcher.adapter.test.ts`; o caminho de teste manual (`dispatchTestWebhook`) foi o testado ao vivo acima, e ambos os pontos de origem chamam o mesmo `incrementDailyUsage`, sem lógica adicional condicional entre eles.

### 🆕 Correção de rumo (frontend): Playground vira Dashboard de verdade, alertas reais, uso 4x (2026-09-07)

Fecha a pendência da correção de rumo pedida pelo usuário: o que era **"Playground"** (busca + "ver webhook chegando na tela" como simulação) virou o **Dashboard de verdade** — a tela padrão pós-login, sem clima de teste/sandbox. Não tocou `backend/` (nenhum arquivo).

**1. Renomeação Playground → Dashboard:**
- Rota `/app/playground` → `/app/dashboard` (`app.routes.ts`, redirect padrão de `/app` ajustado, `data.title` → `"Dashboard"`). `login.ts` e `payment.html` (link da marca) atualizados pro novo caminho.
- Sidebar (`app-shell.html`): label "Playground" → "Dashboard", ícone trocado de um "play" (▶) pra um grid 2×2 (mais alinhado com o conceito de painel de uso do que "testar algo").
- **Renomeação interna também** (não só rota/label): `pages/playground/` → `pages/dashboard-home/` (`Playground` → `DashboardHome`, `app-playground` → `app-dashboard-home`), pra evitar que o próximo agente encontre uma classe chamada `Playground` mapeada pra rota `/dashboard` e se confunda. `account.service.ts`: `playgroundSearchTenders`/`playgroundGetTender` → `searchTenders`/`getTender`, `PlaygroundSearchParams`/`PlaygroundSearchResult` → `TenderSearchParams`/`TenderSearchResult` (as rotas HTTP em si continuam batendo em `/v1/account/playground/tenders*` no backend — só os nomes do lado frontend mudaram). Texto da tela reescrito (intro, sem menção a "teste"/"simulação"); o toggle "Ver como isso funciona via API" (curl) foi mantido como extra educativo, conforme autorizado.
- Busca de licitações (`search-panel`) mantida estruturalmente igual (já era uso real) — só ajuste dos nomes de método acima, nenhuma mudança de UX.

**2. Simulação de webhook → alertas reais (`components/alerts-panel/`, era `monitor-panel/`):** reescrito do zero, não é mais polling sobre `webhook-preview` (matching simulado). Agora:
- Form de criação compacto (nome opcional, UF, modalidade, palavra-chave opcional, URL) chamando `accountService.createWebhook` — o mesmo método real usado em Configurações → Webhooks, só com uma UI mais enxuta (sem edição/teste/reativação/secret aqui, só criação — texto no form aponta pra Configurações pra quem precisar de mais opções).
- Seletor ("Acompanhar") com os webhooks reais do usuário (`listWebhooks()`).
- Feed real de entregas: `GET /v1/account/webhooks/:id/deliveries` (rota nova do backend, já pronta desde a seção anterior) via `accountService.getWebhookDeliveries(id)` — poll a cada 25s, cada entrega mostra sucesso/falha, timestamp, tentativas, status HTTP e erro (quando houver), com destaque visual ("nova") por 5s pra entrega vista pela 1ª vez desde que o webhook foi selecionado. Estado vazio honesto: "Nenhuma entrega ainda -- assim que aparecer uma licitação com esse critério, você vê aqui.".
- **Removida** a chamada a `GET /v1/account/playground/webhook-preview` do frontend (rota antiga de simulação) — `playgroundWebhookPreview`/`WebhookPreviewParams`/`WebhookPreviewResult` deletados de `account.service.ts`. A rota continua existindo no backend (decisão do lead: pode ficar sem uso), só não é mais chamada pela UI.

**3. Gráficos de uso em Configurações, 4 categorias (`daily-usage-chart`, `rest-mcp-chart` → `usage-breakdown-chart`):**
- `account.service.ts`: `DailyUsageDay`/`DailyUsageResponse` atualizados pro contrato novo (`api_count`/`mcp_count`/`ui_count`/`webhook_count`/`total_count`, `totals:{api,mcp,ui,webhook}` no lugar de `totalRest`/`totalMcp` soltos). Novo `WebhookDelivery` + `getWebhookDeliveries()`.
- `daily-usage-chart`: barra empilhada agora com 4 séries (API/MCP/Dashboard/Webhook) em vez de 2 — mesma técnica de SVG puro, só generalizada de 2 pra 4 segmentos empilhados por barra.
- `rest-mcp-chart` renomeado pra **`usage-breakdown-chart`** (`RestMcpChart` → `UsageBreakdownChart`) — donut de 4 fatias (era 2), centro mostra o total de chamadas em vez de um percentual único (não fazia mais sentido destacar 1 categoria só com 4 delas). Legenda lista as 4 com contagem+percentual.
- **2 tons novos no design system** (`styles.scss`): `--color-teal-600: #3f7d6c` (Dashboard/UI) e `--color-terracotta-500: #b56a3a` (Webhook) — escolhidos pra ter separação de matiz clara tanto do navy (API) quanto do dourado (MCP) já existentes, mantendo a mesma paleta "institucional" (nem um novo azul nem um novo amarelo que colidisse visualmente).
- `usage-card.html`: título do donut "REST vs MCP" → "Uso por origem" (não faz mais sentido nomear só 2 das 4 categorias no título).

**4. Bug de responsividade real encontrado e corrigido (grid blowout clássico, ~768px):** os 3 formulários com `grid-template-columns: 1fr 1fr` (`search-form-row`, `alert-form-row` novo, `webhook-form-row`) estouravam a largura da viewport em ~768px (tablet) — um `<input type="number">` (campo "Valor máximo") ficava com o canto direito for a da tela, confirmado via `document.documentElement.scrollWidth` (780px vs 753px de viewport) e um script que lista elementos com `getBoundingClientRect().right > viewport`. Causa raiz: grid item tem `min-width: auto` por padrão, que pro conteúdo de um `<input>`/`<select>` não encolhe abaixo do intrínseco, então 2 colunas de conteúdo largo não cabem em containers estreitos mesmo com `1fr 1fr`. Corrigido com `min-width: 0` nos filhos diretos `.form-group` de cada uma das 3 grids (`search-panel.scss`, `alerts-panel.scss`, `webhooks-table.scss`) — fix padrão pra esse tipo de estouro, sem mudar nenhum outro comportamento de layout.

**Testado AO VIVO** (Cognito real + backend real na porta 3577 + DynamoDB Local real, via Chrome DevTools MCP, `ng serve --port 4201` já rodando de sessão anterior, reaproveitado):
- Login com usuário de teste → redireciona pro shell em `/app/dashboard` (não mais `/app/playground`), sidebar com label/ícone novos, zero erros de console.
- **Alerta real criado ao vivo**: form compacto (`uf:GO`, `modalidade:"Pregão - Eletrônico"`, `webhook_url:127.0.0.1:9999/hook-teste-dashboard`) → `POST /v1/account/webhooks` real (201), apareceu no seletor "Acompanhar", status "Ativo", estado vazio correto antes de qualquer entrega.
- **Feed de entregas real confirmado**: disparado `POST .../test` (via Configurações, mesmo webhook) → voltando ao Dashboard, o feed mostrou a entrega real (`Falha na entrega`, timestamp, `1 tentativa(s)`, `IP resolvido bloqueado (range privado/link-local/loopback): 127.0.0.1`) — prova que é o SSRF guard real bloqueando e a entrega real aparecendo, não uma simulação.
- **Gráficos de Configurações com os 4 contadores não-zero de verdade**, gerados nesta própria sessão de teste: chamada real `GET /v1/tenders?uf=GO` via `curl` com uma API key real criada na tela (`api_count: 1`) + `mcp_count`/`ui_count`/`webhook_count` já não-zero de sessões anteriores (uso do Dashboard novo gerou `ui_count`, o teste de webhook gerou `webhook_count`) → donut final confirmado: **API — 1 (13%), MCP — 1 (13%), Dashboard — 4 (50%), Webhook — 2 (25%)**, 8 chamadas no total, barra empilhada de 30 dias mostrando as 4 cores. Chave de API de teste revogada e webhook de teste excluído ao final (dado de teste limpo).
- **Responsividade testada redimensionando o browser de verdade** (Chrome DevTools MCP `resize_page`, não só leitura de CSS) em 3 larguras — 390px (mobile), 768px (tablet), 1440px (desktop) — no Dashboard novo e em Configurações: confirmado `document.documentElement.scrollWidth === clientWidth` (sem overflow horizontal) nas 3 larguras após o fix do item 4; formulários colapsam pra 1 coluna em mobile, tabelas largas mantêm seu próprio scroll horizontal interno (`.table-scroll`), sidebar colapsa pra ícone-só em mobile (comportamento pré-existente, confirmado ainda funcionando).
- `npx ng build`: limpo (só os 3 warnings CommonJS já conhecidos do `amazon-cognito-identity-js`). `npx ng test --watch=false`: 1/1 passando (nenhum teste novo de frontend nesta sessão, suíte é só o placeholder `app.spec.ts` desde o início do projeto).

**Não testado ao vivo:**
- Uma licitação nova batendo com um alerta de verdade durante a sessão de teste (dependeria da ingestão real, ~15min) — mesma limitação já documentada nas rodadas anteriores do Playground; o caminho de "SSRF bloqueado mas contabilizado" já prova que o feed real funciona ponta a ponta.
- IDOR entre dois clientes Cognito diferentes na UI do alerts-panel — mesma limitação estrutural já documentada (só 1 usuário de teste confirmado no User Pool), coberta pela mesma garantia estrutural do backend (`req.cognitoUser.sub` em `listDeliveriesForOwnedFilter`).

### 🏁 Rodada 10 de 10 (ÚLTIMA — verificação cruzada final + consolidação, SEM feature nova) (2026-09-07)

Propósito estritamente restrito (pedido pelo lead): reler o diff acumulado das Rodadas 6-9 procurando inconsistência entre elas, rodar a suíte inteira do zero, fazer um smoke test final ponta a ponta, e consolidar o resumo executivo de todo o lote de 10 rodadas. Nenhuma feature nova. Não tocou `src/billing/nfse-payload.ts` (Seção 12, fechada) nem Fase 7/8.

**Verificação cruzada entre as Rodadas 6-9 — 3 pontos específicos pedidos pelo lead, nenhum bug novo encontrado:**
- **`getPaymentById` (novo na Rodada 9, `asaas-client.ts`) usado em outro lugar que devia mas não usa?** Não — é chamado só dentro de `reconcilePlanTiers` (`billing/reconciliation.service.ts`), exatamente seu único uso pretendido. Confirmado varrendo todo `src/` por escritas em `plan_tier`: `setPlanTierForAsaasCustomer` (`customer-plan-sync.ts`) continua o único ponto de escrita real, usado por 3 chamadores — `upgradePlanForAsaasCustomer`/`downgradeToFreeForAsaasCustomer` (caminho webhook em tempo real, evento real do Asaas, sem necessidade de releitura) e `reconcilePlanTiers` (caminho de snapshot paginado, onde a releitura pontual da Rodada 9 é necessária). Não há um 4º caminho que devesse reusar `getPaymentById` e não usa.
- **A trava `runExclusive`/`ingestionJobRunning` do scheduler (Rodada 6) cobre a reconciliação de billing (Rodada 9, a cada 30min)?** Não — e isso está correto por design, não é bug. Lendo `src/scheduler.ts`: a trava só envolve `runIncrementalIngestion`/`runReconciliation` (os 2 jobs de tenders), porque os dois competem pelo mesmo recurso externo (API do PNCP) e pelo mesmo estado global (`RateLimitMetrics`, `state#global`). `reconcilePlanTiers` (billing) é registrado como um 3º `cron.schedule` totalmente separado, sem trava nenhuma — mas ele fala com uma API externa diferente (Asaas, não PNCP) e escreve em `ApiKeys`/`plan_tier`, nunca em `RateLimitMetrics` ou `Tenders`/`Checkpoint`. Colocar as 3 jobs atrás da mesma trava não eliminaria nenhuma corrida real (não há recurso compartilhado entre elas) e só introduziria atraso artificial na reconciliação de billing (dinheiro real) se uma ingestão de tenders demorasse. Verificado também que a própria `reconcilePlanTiers` é seguro contra sobreposição consigo mesma (se uma execução do job de 30min atrasar além do próprio intervalo): cada escrita de `plan_tier` já é protegida por uma releitura fresca (`getPaymentById`) imediatamente antes, então mesmo 2 execuções concorrentes do mesmo job não reintroduziriam o bug que a Rodada 9 corrigiu.
- **Nomenclatura/padrão de teste divergente entre os arquivos `.test.ts` novos das Rodadas 6-9?** Não — inspecionados os 15 arquivos de teste novos (`rate-limit-tracking`, `pncp-client`, `ingestion.service`, `reconciliation.service` (tenders e billing), `ttl-cache`, `client-rate-limit`, `api-key.middleware`, `format`, `usage.service`, `customer-plan-sync`, `webhook-delivery-queue.repository`, `webhook-queue-recovery`, `invoice.repository`, `ops-alert`). Todos seguem o mesmo padrão: `vi.mock("../common/dynamodb-client", ...)` com um `sendMock` compartilhado, comentário padronizado "Import depois dos mocks (hoisted pelo vitest)" quando aplicável, `describe`/`it` em português descrevendo o comportamento (não a implementação), `beforeEach`/`afterEach` para reset de mock. Nenhuma divergência de convenção encontrada.

**Suíte de testes rodada do zero:** `npm test` → **224/224 passando** (nenhuma mudança de código nesta rodada, só reexecução). `npx tsc --noEmit` → limpo. `npm audit` → 2 moderados (só `node-cron→uuid`, mesma cadeia deferida desde a Rodada 5, sem regressão).

**Smoke test final ponta a ponta (servidor real, porta dedicada `4580` — confirmada livre/distinta de qualquer outro projeto antes de subir — DynamoDB Local real, containers já no ar há 4h+, não recriados):**
- `GET /health` → schema correto do LicitaHawk (`{"status":"ok","version":"0.1.0",...,"dependencies":{"dynamodb":"ok"}}`).
- Ingestão: base já populada (3400+ tenders reais do PNCP de rodadas anteriores, persistente via Docker volume) — busca real confirmada, ver próximo item.
- `GET /v1/tenders?uf=GO&limit=2` (cliente pro real, API key seedada nesta rodada) → 200 com 2 licitações reais de Goiás.
- `POST /v1/filters` com `uf=GO`, `modalidade`, `webhook_url=http://127.0.0.1:9999/hook` → 201, filtro criado de verdade.
- `POST /v1/filters/{id}/test` → 202 `queued`, **log real do servidor confirma o SSRF guard bloqueando**: `[webhook-queue] disparo bloqueado por SSRF | ... IP resolvido bloqueado (range privado/link-local/loopback): 127.0.0.1`.
- MCP via SDK oficial (`scripts/test-mcp-client.ts`, corrigido na Rodada 8 pra realmente falhar se `isError`): handshake real, `listTools` retornando as 8 ferramentas, `search_tenders` (dado real do PNCP pra UF CE), `create_saved_filter`, `list_my_saved_filters` — as 4 chamadas completaram sem erro, `EXIT_CODE=0`.
- **Rate-limit-por-minuto não afetando quota mensal (regressão da Rodada 7), reconfirmado uma última vez**: burst real de 40 requisições concorrentes (`curl` em paralelo de verdade, `wait`) contra cliente Free novo (limite 30/min) → `30×200 + 10×429`; `UsageCounters` lido direto do DynamoDB Local depois → `request_count: 30` (não 40) — as 10 rejeitadas por rate limit não consumiram quota mensal.
- Reconciliação de billing rodando ao vivo contra a API REAL de produção do Asaas (só leitura): `npx tsx scripts/run-reconciliation-once.ts` → `{"checked":0,"driftFound":0,"driftFixed":0,"errors":0}`, sem erro.
- Dados de teste desta rodada (3 `ApiKeys`, 2 `SavedFilters`, 1 `UsageCounters`) removidos via `DeleteCommand` direto no DynamoDB Local ao final; processo do servidor isolado (`PORT=4580`) finalizado (porta confirmada liberada via `netstat`), containers Docker (`dynamodb-local`/`dynamodb-admin`) não tocados, seguem saudáveis.

**Nenhum bug novo encontrado nesta rodada** — nenhuma correção de código foi necessária. A rodada serviu puramente pra confirmar consistência entre as Rodadas 6-9 e reconfirmar, do zero, que tudo que as rodadas anteriores relataram continua verdadeiro.

### 🎯 Avaliação final honesta — pronto pra considerar a Fase 7?

**Do ponto de vista de qualidade de código local: sim, o projeto está pronto pra você considerar avançar pra Fase 7.** As Fases 1-6 passaram por uma revisão inicial de 4 lentes (Seção 11) e depois por 9 rodadas adicionais independentes (5 de feature + 4 de verificação cética dedicada, mais esta 10ª de consolidação) que, juntas, encontraram e corrigiram **21 bugs reais** (contando desde a Seção 11) sem nenhum reaparecer, com 224 testes automatizados cobrindo a lógica mais crítica e frágil a regressão, `npx tsc --noEmit` limpo, e `npm audit` estável em 2 avisos moderados conscientemente deferidos (breaking change de baixo risco, sem exploit path real hoje).

**O que ainda merece atenção antes da Fase 7 (nada que dependa da própria Fase 7):**
1. **Teste de reconciliação de tenders com item sintético omitido** — pendência honesta desde a Rodada 1, nunca fechada em nenhuma das 10 rodadas (é um teste de integração contra DynamoDB Local real, não lógica pura mockável; os testes unitários de `reconciliation.service.ts` cobrem cálculo de janela/delegação, não esse cenário específico). Baixo risco (a lógica de dedupe já é coberta por outros testes), mas é o único item de teste formal genuinamente em aberto.
2. **Fluxo de cadastro real** (item #1 das 10 sugestões, ainda pendente) — hoje `asaas_customer_id` só é vinculado por script de dev. Isso não é bug de código, mas sem ele nenhum cliente real consegue ter `plan_tier` sincronizado automaticamente — provavelmente vira pré-requisito de qualquer soft launch (Fase 8.3), vale decidir se entra antes ou depois da Fase 7.
3. **App Claude Desktop literal nunca testado** (ambiente de desenvolvimento é headless em todas as 10 rodadas) — testado exaustivamente via protocolo/SDK oficial real, que cobre a lógica, mas não a experiência real do app. Baixo risco técnico, mas vale um teste manual rápido assim que houver acesso a um ambiente com GUI, antes de anunciar suporte a Claude Desktop pro cliente final.

Nada do que falta é um bloqueador de qualidade de código — são lacunas de teste/processo conhecidas e já documentadas, não riscos escondidos.

### 🐛 Bugs reais encontrados e corrigidos — as 10 rodadas (lista consolidada, 1 linha cada)

1. **R2** — `src/common/auth/api-key.middleware.ts` (`authenticate`) sem `try/catch`: falha do DynamoDB no middleware mais executado do sistema derrubava o processo inteiro (DoS de uma linha).
2. **R2** — `GET /v1/tenders?limit=abc` (ou negativo/>100) virava `NaN` sem validação, passado direto pro `Limit` do `QueryCommand`.
3. **R2** — `dataInicial`/`dataFinal` informados sozinhos (sem o par) eram silenciosamente ignorados em vez de erro explícito.
4. **R3** — `POST /mcp` era a única rota autenticada sem `clientRateLimit` (rajada sem limite por minuto).
5. **R3** — `create_saved_filter` (ferramenta MCP) nunca validava `uf`/`webhook_url`, diferente da rota REST equivalente.
6. **R3** — `list_my_saved_filters` (MCP) sem `try/catch`: falha do DynamoDB rejeitava a Promise da rota `/mcp` inteira (500 pra toda a chamada JSON-RPC).
7. **R3** — Erros internos não-`HttpError` vazavam mensagem crua (stack/detalhe do SDK) pro modelo consumidor do MCP.
8. **R4** — `src/billing/asaas-webhook.router.ts`: estorno/chargeback (`PAYMENT_REFUNDED`/`_CHARGEBACK_*`) nunca rebaixava `plan_tier` — cliente ficava com acesso pago de graça pra sempre após reaver o dinheiro (bug de negócio grave, perda de receita ativa).
9. **R4** — Circuit breaker (`src/webhook/circuit-breaker.ts`) sem nenhuma rota de recuperação: filtro desativado por falhas ficava morto pra sempre, sem jeito de reativar sem perder histórico.
10. **R5** — `POST /v1/filters/:id/test` e `/reactivate` (`webhook.router.ts`) sem `clientRateLimit`, mesma classe de gap que a R3 já tinha fechado em `/mcp`.
11. **R6** — `pncp-client.ts`: `fetch()` ao PNCP sem timeout algum, combinado com `scheduler.ts` sem guarda contra execução sobreposta do cron (podia dobrar a taxa efetiva de requests e causar corrida no estado global de rate-limit).
12. **R6** — `ingestion.service.ts`: checkpoint corrompido/fora do formato `YYYYMMDD` travava a ingestão incremental pra sempre, sem autocorreção.
13. **R7** — `client-rate-limit.ts`/`api-key.middleware.ts`: requisição barrada pelo limite POR MINUTO ainda consumia quota MENSAL do plano (burst acidental podia queimar metade da quota mensal de um cliente Free sem entregar metade do que cobrou).
14. **R8** — `scripts/test-mcp-client.ts` (utilitário de smoke test, usado como evidência "ao vivo" desde a R3): chamava `search_tenders` com `uf` no formato errado e nunca checava `isError`, imprimindo "OK" mesmo com uma tool de fato quebrada — verificação enganosa, não bug de produção, mas corrigido pra não mentir mais.
15. **R9** — `src/billing/reconciliation.service.ts` (`reconcilePlanTiers`): TOCTOU entre a listagem inicial (snapshot, pode levar minutos) e a escrita de `plan_tier` podia reverter silenciosamente um downgrade legítimo de estorno/chargeback já processado pelo webhook em tempo real — mesma classe de bug de negócio da R4 (perda de receita ativa), reaberta por um segundo caminho não coberto antes.

**Nenhum bug novo na R10** — só verificação cruzada e reconfirmação.

### ✅ O que está PRONTO, verificado de verdade (não só "compilou") e não precisa de retrabalho

- **Fase 0** (conta AWS, Asaas, domínio `licitahawk.com`, ToS rascunhado) — pendências pontuais documentadas na própria Fase 0 abaixo, nenhuma bloqueia código.
- **Fases 1-6 completas, integradas, e re-testadas numa 5ª rodada de revisão pós-implementação** (funcional + qualidade + segurança + completude, 4 lentes independentes — ver Seção 11). Todos os achados reais dessa rodada **já foram corrigidos e re-verificados ao vivo**, incluindo:
  - Bug crítico de perda de dado (checkpoint de ingestão avançava mesmo com falha) — corrigido.
  - Bug crítico de crash de processo (rota sem try/catch, DoS de uma linha) — corrigido, com middleware de erro global.
  - Brecha de SSRF em IPv6 (metadata da AWS) — corrigida.
  - Bug de negócio grave: pagamento confirmado no Asaas nunca atualizava o plano do cliente — corrigido e testado ao vivo (`starter→pro` confirmado).
  - Limites de plano (Free não podia ter webhook) nunca eram checados — corrigido.
  - Mais 5 achados menores (ver Seção 11 pra lista completa com arquivo:linha).
- **Investigação e correção do payload de nota fiscal (Seção 12)**: acessei a produção real do projeto irmão `pster-finance` (mesmo CNPJ prestador) via túnel SSH e confirmei os campos fiscais que **realmente autorizam nota em produção**. Corrigi `src/billing/nfse-payload.ts` pra bater exatamente com essa config.

### 🟡 Limitação conhecida e ACEITA pelo usuário (não é bug, não precisa de mais investigação)

Emissão de NF-e em `FOCUS_ENV=homologacao` não chega a `autorizado` — é um problema do **ambiente de sandbox de São Paulo dentro do Focus** pra essa inscrição municipal (rejeita leiaute 1 e leiaute 2 simultaneamente, ligado à transição da Reforma Tributária), **não do payload nem do código** — já retestei com a config idêntica à de produção e o erro persiste, confirmando que é do ambiente de teste. **Decisão do usuário: aceitar como limitação conhecida.** Confirmação de `autorizado` de verdade fica pra quando a Fase 7 usar `FOCUS_ENV=producao`. **Não tente "resolver" isso de novo** — já foi investigado a fundo (Seção 12), a causa raiz está identificada e a decisão já foi tomada.

### ⚪ Pendências reais e honestas (não bloqueiam nada, só genuinamente não foram feitas)

- Teste de reconciliação com item sintético propositalmente omitido (a lógica já está provada por outros testes, falta só esse teste formal específico).
- Handshake do MCP testado via protocolo real (SDK oficial) mas não com o **app** Claude Desktop de verdade (ambiente de desenvolvimento é headless, sem GUI).

### 🆕 Rodada 9 de 10 (4ª de um 2º lote — verificação profunda + testes, SEM feature nova) — Webhook/billing (2026-09-07)

Contexto: mesmo propósito restrito das Rodadas 6-10 (verificação cética do código real + ampliação da suíte de testes, nada de feature nova). Escopo: `src/webhook/webhook.router.ts`, `webhook-delivery-queue.repository.ts`, `webhook-queue-recovery.ts`, `circuit-breaker.ts`, `in-memory-webhook-queue.adapter.ts`, `src/billing/asaas-webhook.router.ts`, `focus-webhook.router.ts`, `customer-plan-sync.ts`, `reconciliation.service.ts`, `asaas-client.ts`, `plans.ts`, `src/common/ops-alert.ts`. Módulo mais sensível do projeto (dinheiro real, chaves de produção reais do Asaas no `.env`). Não tocou `src/billing/nfse-payload.ts` (Seção 12, fechada) nem Fase 7/8.

**1 bug real de negócio encontrado e corrigido (race de escrita em `plan_tier` entre reconciliação e webhook, exatamente o cenário pedido pelo lead pra investigar):**

- **[MÉDIO-ALTO, dinheiro real] `reconcilePlanTiers` (`src/billing/reconciliation.service.ts`) podia reverter silenciosamente um downgrade legítimo de estorno/chargeback já processado pelo webhook em tempo real, por um TOCTOU (time-of-check-to-time-of-use) entre a listagem e a escrita.** O job lista TODOS os pagamentos `CONFIRMED`/`RECEIVED` dos últimos 3 dias no início da execução (`listPaymentsByStatusSince`, paginado, pode levar de segundos a minutos numa base maior) e só then itera escrevendo `plan_tier` a partir desse snapshot inicial. Se um evento `PAYMENT_REFUNDED`/`PAYMENT_CHARGEBACK_*` chegar via webhook (`asaas-webhook.router.ts` → `downgradeToFreeForAsaasCustomer`, Rodada 4) para o **mesmo pagamento** depois que a listagem já capturou seu status antigo (`CONFIRMED`) mas antes da reconciliação chegar em processá-lo, a reconciliação escrevia o tier de volta pra cima com dado desatualizado — desfazendo silenciosamente o downgrade que acabou de acontecer corretamente. É a mesma classe de bug de negócio (perda de receita ativa) que a Rodada 4 já tinha corrigido no caminho direto do webhook, reaberta aqui por um segundo caminho (reconciliação) que a Rodada 4 nunca cobriu. Nenhum teste ou verificação anterior (Rodadas 4/6/7/8) tocou nesse cenário especificamente — não é uma contradição do que já tinha sido validado, é um gap real não coberto antes. **Corrigido**: nova função `getPaymentById` em `asaas-client.ts` (GET de um único pagamento, sempre com o status mais recente do Asaas) chamada imediatamente antes de cada escrita de `plan_tier` em `reconcilePlanTiers` — se o status já não for mais `CONFIRMED`/`RECEIVED` nesse instante (ex.: virou `REFUNDED`/`CHARGEBACK_REQUESTED` nesse meio-tempo), a reconciliação pula esse pagamento sem tocar o tier, deixando o que o webhook em tempo real já decidiu. Custo aceito: 1 GET extra por pagamento reconciliado — job roda a cada 30min, não é hot path, não há orçamento de latência sensível aqui. Coberto por 2 testes de regressão formais (`reconciliation.service.test.ts`) simulando exatamente esse cenário (releitura mostrando `REFUNDED` e `CHARGEBACK_REQUESTED` respectivamente, ambos confirmando `setPlanTierForAsaasCustomer` NUNCA chamado).

**Releitura cética dos demais itens pedidos pelo lead, sem achado adicional de bug:**

- **Fila durável (Rodada 4) vs. `in-memory-webhook-queue.adapter.ts` — dois lugares de verdade?** Não. `enqueue()` é o único ponto de entrada (`webhook-queue.instance.ts` exporta uma única instância de `InMemoryWebhookQueueAdapter`, usada por `webhook.router.ts`/`filter-matcher`/`webhook-queue-recovery.ts`), e a persistência (`persistPendingDelivery`/`removePendingDelivery`) é só uma casca de durabilidade em volta do mesmo processamento em memória (retry/backoff/circuit-breaker), não uma fila paralela concorrente. Confirmado lendo o código e **confirmado ao vivo nesta rodada com o ciclo completo observado numa única execução ininterrupta** (ver evidência abaixo) — fecha a limitação honesta que a própria Rodada 4 tinha documentado ("não pude observar o ciclo completo até o fim por instabilidade do ambiente compartilhado").
- **Recovery no boot processando o mesmo item 2x (idempotência real)**: `recoverPendingWebhookDeliveries` (`webhook-queue-recovery.ts`) remove o registro órfão da tabela durável **ANTES** de rechamar `enqueue()` (não depois) — testado formalmente agora (`webhook-queue-recovery.test.ts`, teste de regressão que verifica a ORDEM real das chamadas via um array de eventos, não só que ambas aconteceram). Isso significa que mesmo se o processo morrer de novo no meio do reprocessamento, o pior caso é reenviar a MESMA entrega de novo (protegida pelo `Idempotency-Key` reaproveitado do job original no lado do cliente), nunca perder silenciosamente nem duplicar na tabela durável. `attempt` é sempre resetado pra `1` na recuperação (não continua de onde parou) — comportamento correto e já documentado pela Rodada 4, confirmado de novo.
- **Reconciliação concorrente com webhook pro mesmo cliente**: era exatamente o achado real reportado acima — corrigido.
- **Guarda de estado terminal da NF-e (Fase 5.4) com callback fora de ordem**: `applyStatusUpdateGuarded` (`src/billing/invoice.repository.ts`) usa `ConditionExpression` avaliada atomicamente no próprio `UpdateItem` (nunca get-then-put) — retestei formalmente o cenário específico pedido pelo lead (`invoice.repository.test.ts`, módulo sem NENHUMA cobertura de teste antes desta rodada apesar de ser citado desde a Rodada 4 como reimplementação do guard do `pster-finance`): callback atrasado tentando reverter `autorizado→processando_autorizacao` bloqueado, `cancelado→autorizado` bloqueado, transição legítima `autorizado→cancelado` permitida, eco idempotente do mesmo status tratado como aplicado (não como reversão bloqueada). Nenhum bug encontrado — a guarda está correta como já estava.
- **Downgrade por estorno/chargeback (bug da Rodada 4) — segundo caminho que ainda deixasse escapar**: o único outro lugar que escreve `plan_tier` além do webhook direto é exatamente a reconciliação (achado acima, já corrigido). Não há um terceiro caminho — `setPlanTierForAsaasCustomer` (`customer-plan-sync.ts`) é o único ponto de escrita real de `plan_tier`, usado só por `downgradeToFreeForAsaasCustomer`/`upgradePlanForAsaasCustomer`/`reconcilePlanTiers`, confirmado varrendo todo `src/` por escritas em `plan_tier`.

**Testes novos (Vitest) — 50 no total, todos passando, nenhum teste antigo quebrado:**

- **`src/billing/reconciliation.service.test.ts` (NOVO, 10 testes)** — módulo sem cobertura formal antes: sincroniza tier quando pagamento confirmado bate com plano conhecido; idempotente quando tier já bate (sem escrita/alerta); ignora valor sem plano correspondente; **2 testes de regressão formal do bug desta rodada** (releitura mostrando `REFUNDED`/`CHARGEBACK_REQUESTED` pula sem escrever); confirma que `getPaymentById` é chamado com o id certo antes de qualquer escrita; erro de listagem por status não interrompe o outro status; erro da releitura pontual vira `errors++`/alerta sem lançar; erro de `setPlanTierForAsaasCustomer` isolado por pagamento (não trava os demais); os 2 status (`CONFIRMED`/`RECEIVED`) sempre consultados.
- **`src/billing/customer-plan-sync.test.ts` (NOVO, 8 testes)** — módulo também sem cobertura antes: `setPlanTierForAsaasCustomer` via GSI (atualiza/idempotente/cliente órfão sem vínculo/propaga erro); `upgradePlanForAsaasCustomer` (wrapper booleano); `downgradeToFreeForAsaasCustomer` (ops-alert critical com motivo, **teste de regressão formal da idempotência do bug da Rodada 4** — reenviar o mesmo evento de estorno 2x não duplica downgrade nem alerta, cliente órfão não dispara alerta).
- **`src/webhook/webhook-delivery-queue.repository.test.ts` (NOVO, 8 testes)** — módulo também sem cobertura antes: persiste com `delivery_id` gerado; **nunca persiste o campo `secret`** (grep no `Item` serializado); paginação completa de `Scan` via `LastEvaluatedKey`; remove por `delivery_id`; propaga erros do DynamoDB em todas as 3 funções.
- **`src/webhook/webhook-queue-recovery.test.ts` (NOVO, 7 testes)** — módulo também sem cobertura antes: no-op quando fila vazia; re-enfileira relendo secret de `SavedFilters` com `attempt:1` e mesmo `idempotencyKey`; **teste de regressão formal da ordem remove-antes-de-enfileirar**; descarta quando filtro já foi deletado; `opsAlert` critical sem lançar quando o `Scan` inicial falha; item com falha isolado não impede os demais; falha do próprio `enqueue()` de recuperação vira `opsAlert` warning sem lançar.
- **`src/billing/invoice.repository.test.ts` (NOVO, 13 testes)** — módulo também sem cobertura antes (guarda de estado terminal da NF-e): todas as transições cobertas (sem status prévio, não-terminal→qualquer, **2 regressões formais de callback fora de ordem terminal→não-terminal bloqueado**, `autorizado→cancelado` permitida, eco idempotente do mesmo status, `cancelado→autorizado` bloqueada), campos opcionais no `SET` só quando fornecidos, `error_message` removido/setado corretamente, erro inesperado propagado, `createInvoice`/`getInvoice` básicos.
- **`src/common/ops-alert.test.ts` (NOVO, 4 testes)** — módulo também sem cobertura antes: formato da linha JSON (`ops_alert`/`severity`/`event`/`timestamp`/contexto), funciona sem contexto explícito, nunca lança com referência circular no contexto, nunca lança mesmo quando `console.error` em si lança.

**Avaliado e decidido não fazer (com motivo):**

- **Teste unitário isolado pra `webhook.router.ts`/`asaas-webhook.router.ts`/`focus-webhook.router.ts` em si** (os handlers de rota): mesmo padrão já usado pelas Rodadas 6-8 — a lógica de negócio real que cada rota delega (`circuit-breaker.ts`, `customer-plan-sync.ts`, `invoice.repository.ts`) já ganhou teste unitário formal nesta rodada; os próprios routers continuam cobertos por teste ao vivo contra o servidor real (ver evidência abaixo), que exercita autenticação real, SSRF guard real, DynamoDB Local real — maior valor de regressão do que mockar Express/`req`/`res` pra recriar o que o teste ao vivo já prova.
- **`in-memory-webhook-queue.adapter.ts` mockado em isolamento**: avaliado e descartado — o ciclo completo (persist→retry→remove) já foi observado AO VIVO nesta rodada numa única execução ininterrupta (ver evidência), que é evidência mais forte do que um teste mockado do orquestrador em si; os componentes que ele orquestra (`circuit-breaker`, `webhook-delivery-queue.repository`, `webhook-dispatcher`, `ssrf-guard`) já têm cobertura unitária própria (algumas desde a Rodada 5, o repositório desta rodada).

**Evidência de verificação:**
- `npx tsc --noEmit`: limpo.
- `npm test`: **224/224 testes passando** (174 herdados da Rodada 8 + 50 novos desta rodada).
- Porta dedicada `4579` confirmada livre antes de subir o servidor; containers Docker (`dynamodb-local`/`dynamodb-admin`, 19h+ de uptime nesta sessão, ~4h desde o último restart) não recriados, confirmados saudáveis antes e depois da rodada.
- `GET /health` → `{"status":"ok",...,"dependencies":{"dynamodb":"ok"}}`, schema do LicitaHawk confirmado antes de qualquer teste ao vivo.
- **Ciclo completo da fila durável observado AO VIVO numa única execução ininterrupta do processo** (fecha a limitação honesta documentada pela própria Rodada 4, que só tinha conseguido observar isso "por partes" devido a instabilidade do ambiente compartilhado naquela ocasião): filtro real criado apontando pra um IP público inalcançável (`203.0.113.1`, TEST-NET-3, não bloqueado pelo SSRF guard por não ser range privado, mas nunca responde), `POST /v1/filters/{id}/test` disparado; `Scan` direto em `WebhookDeliveryQueue` ~1.5s depois confirmou o item persistido (`delivery_id` real, payload completo, sem `secret`) DURANTE as 3 tentativas de rede (timeout de 5s cada + backoff); após a resposta HTTP do endpoint de teste (~17s depois, esgotadas as 3 tentativas), novo `Scan` confirmou a tabela vazia (registro removido); `GetItem` em `SavedFilters` confirmou `consecutive_failures: 1` (circuit breaker incrementado corretamente pela falha real).
- Reconciliação de billing rodada ao vivo contra a API REAL de produção do Asaas (só leitura): `npx tsx scripts/run-reconciliation-once.ts` → `{"checked":0,"driftFound":0,"driftFixed":0,"errors":0}` (sem pagamento confirmado/recebido nos últimos 3 dias no momento do teste, esperado, mesmo resultado que a Rodada 4 já tinha observado) — confirma que o código novo (`getPaymentById`) compila e roda contra a rede real sem erro, mesmo sem ter sido exercido por um pagamento de verdade nesta execução (o cenário de race em si é coberto pelos 2 testes de regressão unitários, não reproduzível de forma segura contra produção real sem gerar um estorno de verdade).
- Dado de teste órfão desta rodada (2 `SavedFilters`, 1 `ApiKeys`) removido via `DeleteCommand` direto no DynamoDB Local ao final; processo do servidor isolado (`PORT=4579`) finalizado (confirmado via `netstat`/porta liberada), sem afetar containers Docker nem qualquer outro processo.

**Discrepância com o que o PLAN.md afirmava "verificado ao vivo" (item pedido explicitamente pelo lead)**: a Rodada 4 tinha documentado como limitação honesta não ter conseguido observar o ciclo completo da fila durável (persist→disparo real→remoção) numa única execução ininterrupta, por instabilidade do ambiente compartilhado na ocasião (~90 processos `node.exe` concorrentes). Nesta rodada, com ambiente menos disputado, esse ciclo completo FOI observado ao vivo numa única execução (ver evidência acima) — não é uma contradição do que a Rodada 4 relatou (ela já tinha sido honesta sobre não ter conseguido), é a confirmação pendente que ela recomendou pra uma rodada futura. Fora isso, nenhuma discrepância real encontrada entre o que rodadas anteriores afirmavam e o comportamento atual do código.

### 🆕 Rodada 8 de 10 (3ª de um 2º lote — verificação profunda + testes, SEM feature nova) — Servidor MCP (2026-09-07)

Contexto: mesmo propósito restrito das Rodadas 6-10 (verificação cética do código real + ampliação da suíte de testes, nada de feature nova). Escopo: `src/mcp/mcp.router.ts`, `src/mcp/format.ts`, `src/mcp/usage.service.ts`, as 8 ferramentas MCP (`search_tenders`, `get_tender_details`, `list_my_saved_filters`, `create_saved_filter`, `delete_saved_filter`, `get_filter_deliveries`, `get_tender_stats`, `get_usage_stats`). Não tocou `src/billing/nfse-payload.ts` (Seção 12, fechada) nem Fase 7/8.

**Lição operacional repetida (mesma da Rodada 4/5/7): antes de testar ao vivo, confirmei que a porta usada não era de outro projeto.** Usei uma porta nova e dedicada (`PORT=4578`, distinta da `4577` já usada e liberada pela Rodada 7) — `GET /health` respondeu `{"status":"ok","version":"0.1.0","node_version":"v24.14.0",...,"dependencies":{"dynamodb":"ok"}}`, payload batendo com o schema do LicitaHawk (não o formato NestJS/`BERR-...` do projeto vizinho que ocupou a porta 3000 na Rodada 7). Processo isolado finalizado ao fim da rodada (PID confirmado via `netstat -ano`, já que o PID retornado por `$!` do subshell do Git Bash não bateu com o PID real do processo Node no Windows — mesma pegadinha de ambiente que rodadas anteriores já registraram, documentada aqui pra quem for reusar esse padrão).

**1 achado real (não um bug de produção, mas uma evidência de verificação enganosa) encontrado e corrigido:**

- **`scripts/test-mcp-client.ts`** (utilitário de smoke test via SDK oficial, citado desde a Rodada 3 como a fonte de "handshake real" contra o servidor MCP) **chamava `search_tenders` com `uf: "CE"` (string), não `uf: ["CE"]` (array)** — desde a Rodada 2, a tool exige array (`z.array(z.string())`). Rodando o script de verdade, essa chamada retornava `isError: true` com `"Invalid arguments for tool search_tenders: uf: Invalid input: expected array, received string"` — só que o script nunca checava `isError`, só imprimia o resultado (que incluía o erro, mas só nos primeiros ~400 caracteres do log, fácil de passar despercebido numa leitura rápida) e seguia pras próximas chamadas, terminando com `"=== OK: ... tudo funcionou ==="` e saindo com código 0 mesmo com uma tool de fato quebrada no meio. Ou seja: **o próprio utilitário usado como evidência de verificação ao vivo em rodadas anteriores mentia "OK" quando pelo menos 1 de 4 chamadas falhava.** Corrigido em duas frentes: `uf: ["CE"]` (chamada corrigida pro formato real da tool) + um helper `assertNoToolError()` que lança se qualquer `callTool` vier com `isError: true`, aplicado às 3 chamadas que importam (`search_tenders`, `create_saved_filter`, `list_my_saved_filters`) — agora o script só imprime "OK" se todas as chamadas realmente tiverem sucedido, e sai com código != 0 se alguma falhar. **Retestado ao vivo depois do fix**: as 4 chamadas (handshake, `listTools`, `search_tenders` com `uf: ["CE"]`, `create_saved_filter`, `list_my_saved_filters`) completaram sem erro, `search_tenders` devolveu dado real (`"2 licitacao(oes) encontrada(s) para UF CE"`, licitação real de Acaraú/CE).

**Releitura cética dos itens pedidos pelo lead, sem achado adicional de bug (verificado ao vivo, não só lido):**

- **Ordem `authenticate`→`clientRateLimit` na rota `/mcp`, sem caminho paralelo que reintroduza o bug da Rodada 7**: confirmado lendo `mcp.router.ts` — `mcpRouter.post("/mcp", authenticate, clientRateLimit, asyncHandler(...))`, exatamente a mesma ordem de `tenders.router.ts`/`filters.router.ts`. `authenticate` (`api-key.middleware.ts`) não toca mais `UsageCounters` (só `GetCommand` de identidade); `incrementAndCheckMonthlyUsage` foi extraída pra função pura exportada e só é chamada por `clientRateLimit` (`client-rate-limit.ts`), depois de confirmar que a requisição passou no limite por minuto — não existe um segundo caminho de entrada pra `/mcp` que pule esse fluxo (é a única rota registrada pra esse path em `server.ts`). **Retestado ao vivo com burst real de 40 requisições concorrentes direto contra `POST /mcp`** (cliente Free novo, `round8-mcp-free`, limite 30/min, corpo JSON-RPC `initialize` mínimo, `curl` em paralelo real via `&`/`wait`, não sequencial): resultado `30×200 + 10×429` (idêntico ao padrão da Rodada 7 pro REST), e `UsageCounters` lido direto do DynamoDB Local depois mostrou `request_count: 30` — as 10 rejeitadas por rate limit não consumiram quota mensal. Confirma ao vivo, na própria rota `/mcp` (não só por leitura de código/inferência de reuso de middleware), que o fix da Rodada 7 realmente se propagou pro MCP.
- **IDOR via MCP** (`get_filter_deliveries`/`delete_saved_filter` com `filter_id` de outro cliente): testado ao vivo com 2 clientes reais (`round8-mcp-a`/`round8-mcp-b`, plano pro) via SDK oficial (`@modelcontextprotocol/client`, handshake real). Cliente A criou um filtro; cliente B chamando `get_filter_deliveries` e `delete_saved_filter` com o `filter_id` de A recebeu `isError: true` + `"Nenhum filtro encontrado..."` nas duas ferramentas; `list_my_saved_filters` de A confirmou o filtro intacto depois das duas tentativas de B. Mesma proteção estrutural já documentada pela Rodada 7 pro lado REST (`assertFilterOwnership`, chave composta `customer_id`+`filter_id`) — `filters.service.ts` (`deleteOwnedFilter`, `listDeliveriesForOwnedFilter`) é a mesma função reusada pelas duas superfícies (REST e MCP), então não há caminho de código duplicado pro MCP que pudesse ter esquecido a checagem.
- **Enforcement de plano na tool nova (`get_tender_stats`) e nas demais**: `get_tender_stats` usa `sampleLimit = planTier === "free" ? 50 : 200` (confirmado lendo `mcp.router.ts`), mesmo critério documentado pela Rodada 3 e ainda intacto. `create_saved_filter` checa `plan.webhooksEnabled`/`plan.maxFilters` (`PLANS`, `billing/plans.ts`) antes de criar. Nenhuma das 8 tools ficou sem o gate que já deveria ter — `delete_saved_filter`/`get_filter_deliveries`/`get_usage_stats` deliberadamente não são plan-gated (leitura/remoção de recurso próprio, mesmo critério já usado nas rotas REST equivalentes, documentado desde a Rodada 3).
- **`format.ts` com dado ausente/nulo (não só payload feliz)**: `normalizeTender` (`pncp-client.ts`) sempre coerciona todo campo do `Tender` pra `string`/`Number` com fallback (`String(x ?? "")`, `Number(x ?? 0)`) antes de gravar em `Tenders` — na prática, um `Tender` já persistido nunca tem campo `undefined`/`null` de verdade, então os `?? null` checks em `formatBRL`/`formatTenderStats` (`format.ts`) são defensivos, não corretivos de um bug observado. Testado formalmente mesmo assim (`format.test.ts`, ver abaixo) simulando `valor_estimado: null` diretamente no formatter (bypassando a normalização) — não lança, cai no caminho `"valor nao informado"`/soma como 0, então mesmo que uma rodada futura mude `normalizeTender` e pare de coercionar, `format.ts` não quebra. Nenhuma discrepância real encontrada.

**Testes novos (Vitest) — 22 no total, todos passando, nenhum teste antigo quebrado:**

- **`src/mcp/format.test.ts` (NOVO, 16 testes)** — módulo sem cobertura formal antes: `formatSearchResult` (mensagem de vazio, listagem numerada com BRL/link, truncamento de `objeto` acima/exatamente no limite de 280 caracteres, nunca vaza `raw_payload`/`keywords_tokenized`, nota de paginação presente/ausente conforme `next_cursor`, `valor_estimado` nulo tratado como "valor nao informado"); `formatTenderDetail` (todos os campos presentes, nunca trunca `objeto`, nunca vaza `raw_payload`); `formatTenderStats` (mensagem de vazio, soma/média corretas, quebra por modalidade em ordem decrescente de contagem, `valor_estimado` nulo tratado como 0 sem lançar, nota de limitação de amostra presente/ausente conforme a amostra bate ou não o teto do plano).
- **`src/mcp/usage.service.test.ts` (NOVO, 6 testes)** — módulo também sem cobertura antes: `getMonthlyUsage` lê via `GetCommand` puro (nunca incrementa, `sendMock` chamado exatamente 1x); contadores corretos pros planos `pro` (50000/600) e `free` (100/30); ausência de item (`Item: undefined`, cliente sem uso registrado) tratada como `request_count: 0`; `monthlyRemaining` nunca fica negativo mesmo com contador acima do limite (cenário de burst já estourado); erro do DynamoDB propagado sem engolir.

**Avaliado e decidido não fazer (com motivo):**

- **Teste unitário isolado (mock) pra `mcp.router.ts` em si** (os 8 handlers de tool, o `toolError()` helper, a rota `/mcp`): avaliado e descartado em favor do mesmo padrão já usado pela Rodada 3 — teste via SDK oficial contra o protocolo HTTP real (`@modelcontextprotocol/client`), que exercita a integração completa (autenticação real, rate limit real, DynamoDB Local real, serialização JSON-RPC real) em vez de mockar o `McpServer`/transporte, que teriam pouco valor de regressão isolados do jeito que o router está estruturado hoje (`buildServer` monta as 8 tools inline, fechadas sobre `customerId`/`planTier` por closure — testar isso mockado exigiria reconstruir boa parte do SDK do MCP em mock, sem ganho real sobre o teste ao vivo que já cobre o caminho de verdade). `format.ts`/`usage.service.ts` (lógica pura/quase pura, fácil de isolar) ganharam teste unitário; o router em si continua coberto por teste ao vivo, como todas as rodadas anteriores já fizeram.

**Evidência de verificação:**
- `npx tsc --noEmit`: limpo.
- `npm test`: **174/174 testes passando** (152 herdados da Rodada 7 + 22 novos desta rodada).
- Porta dedicada `4578` confirmada livre antes de subir o servidor (`curl` retornando `000`/conexão recusada); `GET /health` confirmado batendo com o schema do LicitaHawk antes de qualquer teste ao vivo.
- Containers Docker (`dynamodb-local`/`dynamodb-admin`, 4h+ de uptime) não recriados, confirmados saudáveis antes e depois da rodada.
- Burst de 40 requisições concorrentes reais contra `POST /mcp` (`curl` em paralelo via `&`/`wait`, não sequencial): `30×200 + 10×429`, `UsageCounters` inspecionado direto no DynamoDB Local via AWS CLI confirmando `request_count: 30` (não 40) — fix da Rodada 7 confirmado ao vivo especificamente na rota MCP.
- IDOR via MCP: 2 clientes reais, handshake SDK oficial completo, `get_filter_deliveries`/`delete_saved_filter` com `filter_id` alheio retornaram `isError: true`/"não encontrado" nas duas ferramentas, filtro do dono confirmado intacto via `list_my_saved_filters` depois.
- `scripts/test-mcp-client.ts` corrigido e reexecutado ao vivo depois do fix: as 4 `callTool` completaram sem `isError`, dado real do PNCP confirmado na resposta de `search_tenders`.
- Dados de teste órfãos (2 `SavedFilters` criados por scripts desta rodada) removidos via `DeleteCommand` direto no DynamoDB Local ao final; processo do servidor isolado (`PORT=4578`) finalizado (confirmado via `netstat`/porta liberada), sem afetar containers Docker nem qualquer outro processo.

### 🆕 Rodada 7 de 10 (2ª de um 2º lote — verificação profunda + testes, SEM feature nova) — API REST (2026-09-07)

Contexto: mesmo propósito restrito das Rodadas 6-10 (verificação cética do código real + ampliação da suíte de testes, nada de feature nova). Escopo: `src/tenders/tenders.router.ts`, `tenders.service.ts`, `src/common/query-validation.ts`, `src/common/client-rate-limit.ts`, `src/common/ttl-cache.ts`, `src/common/auth/api-key.middleware.ts`, `src/filters/filters.router.ts`/`filters.service.ts`, `src/webhook/webhook.router.ts` (rotas `/test`/`/reactivate`), `docs/openapi.yaml`. Não tocou `src/billing/nfse-payload.ts` (Seção 12, fechada) nem Fase 7/8.

**Lição operacional repetida (mesma da Rodada 4/5): a porta 3000 local estava ocupada por outro projeto** (`node dist/main.js`, PID confirmado via `Get-CimInstance Win32_Process`) respondendo com formato de erro de NestJS (`{statusCode, message, error, errorCode:"BERR-..."}"`), não o LicitaHawk — `GET /health` nessa porta respondia `200` mas com payload minimalista, quase passou despercebido. Isolado com `PORT=4577 npx tsx src/server.ts` em processo próprio (finalizado ao fim da rodada) antes de qualquer teste ao vivo.

**1 bug real encontrado e corrigido (releitura cética, achado NÃO reportado em nenhuma rodada anterior):**

- **[MÉDIO-ALTO] Requisição barrada pelo limite POR MINUTO ainda consumia quota MENSAL do plano.** `authenticate` (`api-key.middleware.ts`) incrementava `UsageCounters` (teto mensal) e só DEPOIS `clientRateLimit` (`client-rate-limit.ts`) checava o limite por minuto — ou seja, toda requisição que chegava a ser autenticada já custava 1 unidade da quota mensal, mesmo que fosse rejeitada em seguida com `429 RATE_LIMITED` sem nenhum dado servido. **Confirmado ao vivo com burst real de concorrência verdadeira** (40 requisições disparadas simultaneamente em background contra um cliente Free recém-criado, limite 30/min): resultado exato `30×200 + 10×429` (sem race — a operação `UpdateCommand ADD` do DynamoDB é atômica, então nenhuma duplicata/perda mesmo sob concorrência real), mas `UsageCounters` (consultado direto no DynamoDB Local depois) mostrava `request_count: 40` — as 10 requisições que nunca foram atendidas (puro `429`) tinham custado quota mensal de verdade. Para um cliente Free (100 requisições/mês), um único burst acidental de ~50 requisições em 1 minuto queimaria metade da quota do mês inteiro sem entregar metade do que cobrou. **Corrigido**: extraída a lógica de incremento/checagem mensal de `authenticate` para uma função pura nova e exportada, `incrementAndCheckMonthlyUsage(customerId, planTier)` (mesmo arquivo, `api-key.middleware.ts`); `authenticate` agora só identifica o cliente (lookup de API key, popula `req.auth`), sem tocar `UsageCounters`. `clientRateLimit` (`client-rate-limit.ts`) passou a chamar essa função — mas só DEPOIS de confirmar que a requisição passou no limite por minuto. Como toda rota autenticada já aplicava `authenticate` seguido de `clientRateLimit` nessa ordem exata (confirmado varrendo todos os routers: `tenders.router.ts`, `filters.router.ts`, `webhook.router.ts`, e também `mcp.router.ts`, fora do escopo desta rodada mas beneficiado pelo mesmo fix por reusar o middleware compartilhado), a correção não exigiu tocar em nenhum arquivo de rota — só nos dois módulos já no escopo desta rodada. **Retestado ao vivo com o mesmo burst de 40 requisições concorrentes**: `30×200 + 10×429` idêntico (comportamento do rate limit por minuto inalterado), mas `UsageCounters` agora mostra `request_count: 30` — só as requisições de fato atendidas contam. Caminho de "estourou o teto mensal de verdade" retestado separadamente (contador semeado em `99`, uma única requisição real): ainda responde `429 PLAN_LIMIT_EXCEEDED` com `Retry-After: 3600` corretamente, e os headers `X-RateLimit-Limit/Remaining` (por minuto) continuam presentes na resposta (prova de que passou pelo limite por minuto antes de ser barrado pelo mensal).

**Releitura cética dos itens pedidos pelo lead, sem achado adicional (verificado de novo, não só confirmado por leitura):**

- **IDOR** (`filter_id`/`customer_id`): testado ao vivo com 2 clientes reais (`round7-client-a`/`round7-client-b`, plano pro) contra as 4 rotas com `filter_id` (`GET .../deliveries`, `POST .../test`, `POST .../reactivate`, `DELETE /v1/filters/{id}`) — cliente B recebeu `404 NOT_FOUND` nas 4, filtro de A confirmado intacto depois. Não é só checagem de aplicação: `SavedFilters` tem chave composta `customer_id` (HASH) + `filter_id` (RANGE), então um `GetItem`/`DeleteItem` com o `customer_id` errado estrutural mente nunca acha o item (`assertFilterOwnership`, `src/common/filter-ownership.ts`) — proteção ao nível do desenho da tabela, não só de lógica de aplicação que poderia ter um caminho esquecido.
- **Cache (`ttl-cache.ts`) x paginação por cursor x rate-limit-por-cliente**: a chave de cache de `GET /v1/tenders` (`stableParamsKey`) inclui o `cursor` — cursores diferentes nunca colidem no mesmo slot de cache, confirmado lendo `tenders.router.ts`. O cache é deliberadamente compartilhado entre clientes (dado de tender não é customer-específico, documentado desde a Rodada 2) — não há vazamento de "página errada pro cliente errado" porque não existe segmentação por cliente nos dados de tender em si (plano só afeta limite de taxa/quota, nunca o conteúdo retornado). Confirmado ao vivo: `X-Cache: MISS` na 1ª chamada, `HIT` nas seguintes com os mesmos parâmetros, e `X-RateLimit-Remaining` decrementando em AMBAS (`clientRateLimit` roda antes do cache ser consultado, então um HIT ainda custa 1 do limite por minuto — comportamento correto e intencional, cache é otimização de carga no DynamoDB, não isenção de quota).
- **Validação de combinação de query params não testada antes**: `uf` inválida + `cursor` válido → 400 na validação de `uf` (nem chega a olhar o cursor); `uf` multi-valor + `cursor` → 400 explícito (paginação não suportada nesse modo, Rodada 2); `uf` E `modalidade` juntos → 400 (GSIs distintos); `uf` com 6 valores (excede o máximo de 5) + `valorMin > valorMax` juntos → responde o erro de `valorMin/valorMax` primeiro (ordem determinística de validação dentro de `parseSearchQuery`, não um bug — ambos os casos retornam 400 de qualquer forma, só documentado aqui pra quem for depurar um teste que espera uma mensagem específica); nenhuma combinação testada derrubou o processo (`GET /health` confirmado de pé depois de cada uma).
- Nenhuma discrepância real encontrada entre o que o PLAN.md já afirmava "verificado ao vivo" (Rodadas 2/5) e o comportamento atual do código — o achado acima é um gap não coberto antes (interação nova entre dois mecanismos que cada um isoladamente já tinha sido testado), não uma contradição do que já tinha sido validado.

**Testes novos (Vitest) — 30 no total, todos passando, nenhum teste antigo quebrado:**

- **`src/common/ttl-cache.test.ts` (NOVO, 9 testes)** — módulo sem cobertura formal antes: get/set básico, expiração exata no limite do TTL e após, `set` sobre chave existente reinicia o TTL, valores falsy (`0`, `""`, `false`, `null`) armazenados e distinguidos corretamente de "não encontrado" (`undefined`), eviction FIFO ao atingir `maxEntries` (evict da chave mais antiga), sobrescrever uma chave já existente no limite de capacidade NÃO dispara eviction indevida, `maxEntries` padrão (500) respeitado quando não informado.
- **`src/common/client-rate-limit.test.ts` (NOVO, 10 testes)** — módulo também sem cobertura antes: `next()` direto sem tocar DynamoDB quando `req.auth` ausente; headers `X-RateLimit-Limit/Remaining` corretos por plano (free/starter/pro); `429 RATE_LIMITED` com `Retry-After: 60` e `Remaining: 0` ao estourar; **teste de regressão formal do bug desta rodada** (`incrementAndCheckMonthlyUsage` NUNCA chamado quando o limite por minuto já rejeitou); `incrementAndCheckMonthlyUsage` chamado só depois de passar no limite por minuto; `429 PLAN_LIMIT_EXCEEDED` com `Retry-After: 3600` quando o teto mensal estoura depois do por-minuto já ter passado; falha do DynamoDB (checagem por minuto) e falha do incremento mensal ambas viram `next(err)` sem lançar; formato da chave de janela (`min#YYYYMMDDHHmm`) validado via inspeção do `UpdateCommand`.
- **`src/common/auth/api-key.middleware.test.ts` (NOVO, 11 testes)** — módulo também sem cobertura antes: 401 sem tocar DynamoDB quando API key ausente; aceita `Authorization: Bearer` e `X-Api-Key`; 401 quando key não existe ou está `active: false`; **teste de regressão formal do bug desta rodada** (`authenticate` faz exatamente 1 `send()` — só o `GetCommand` de identidade, nunca um 2º `send()`/`UpdateCommand` de `UsageCounters`); falha do DynamoDB vira `next(err)`; `incrementAndCheckMonthlyUsage` testado isoladamente (incrementa via `UpdateCommand ADD`, `exceeded` correto abaixo/acima do limite, limite certo por plano — 100/5000/50000 —, propaga erro sem engolir).

**Avaliado e decidido não fazer (com motivo):**

- **Teste de integração com `supertest` contra as rotas mais críticas**: avaliado e descartado em favor de teste ao vivo real contra o servidor rodando (`PORT=4577`) + DynamoDB Local real — mesmo padrão já usado em todas as rodadas anteriores (2 a 6) para evidência "ao vivo", e que capturou o achado real desta rodada (a interação entre dois middlewares só é visível rodando os dois juntos de verdade, algo que `supertest` com mocks não teria pego tão naturalmente quanto um burst de concorrência real contra um processo real). Adicionar `supertest` como dependência nova só pra formalizar o que já foi verificado ao vivo com evidência concreta (leituras diretas do DynamoDB antes/depois) não pareceu justificar o esforço nesta rodada — candidato pra rodada futura se o projeto quiser suíte de regressão automatizada ponta a ponta em CI (hoje não há CI configurado).
- **Bump de versão do `docs/openapi.yaml`**: o documento já descreve genericamente "limite mensal do plano OU limite por minuto excedido" pro `429` (linha ~127) sem detalhar a ordem interna de checagem — o fix desta rodada não muda contrato/formato de resposta nenhum pro cliente da API, só corrige quando a quota mensal é debitada internamente. Nenhuma atualização de doc necessária.

**Evidência de verificação:**
- `npx tsc --noEmit`: limpo.
- `npm test`: **152/152 testes passando** (122 herdados da Rodada 6 + 30 novos desta rodada).
- Servidor real rodando isolado (`PORT=4577`, fora da porta 3000 ocupada por outro projeto), DynamoDB Local real (containers já no ar há 4h+, não recriados).
- IDOR: 4 rotas com `filter_id` retestadas ao vivo com 2 clientes reais, todas `404` para o cliente errado, filtro do dono confirmado intacto depois.
- Burst de rate-limit: **concorrência real** (`curl` em background, `wait`), não sequencial — antes e depois do fix, testado com clientes Free distintos, `UsageCounters` inspecionado direto no DynamoDB Local via script Node ad-hoc antes/depois da correção (40 vs 30).
- Caminho de teto mensal excedido retestado depois do fix (contador semeado em 99 via `PutCommand` direto): `429 PLAN_LIMIT_EXCEEDED` correto, headers de rate-limit por minuto presentes (prova de que passou por esse limite antes de ser barrado pelo mensal).
- Processo de teste isolado (`PORT=4577`) finalizado ao fim da rodada, sem afetar containers Docker (`dynamodb-local`/`dynamodb-admin` seguem saudáveis) nem o processo de outro projeto na porta 3000 (não tocado).

### 🆕 Rodada 6 de 10 (1ª de um 2º lote — verificação profunda + testes, SEM feature nova) — Ingestão do PNCP / rate-limit tracking (2026-09-07)

Contexto: depois das 5 rodadas de melhoria de feature acima (agora renumeradas como parte de um lote maior de 10 rodadas sequenciais), este 2º lote tem propósito deliberadamente diferente e mais restrito: verificação cética do código real + ampliação da suíte de testes, nada de feature nova. Escopo desta rodada: `src/tenders/ingestion.service.ts`, `src/tenders/pncp-client.ts`, `src/tenders/rate-limit-tracking.ts`, `src/tenders/rate-limit.router.ts`, `src/tenders/reconciliation.service.ts`, `src/scheduler.ts` (só o agendamento dos 2 jobs de tenders). Não tocou `src/billing/nfse-payload.ts` (Seção 12, fechada) nem Fase 7/8.

**3 bugs reais encontrados e corrigidos (releitura cética, procurando motivo pra rejeitar, não confirmar):**

1. **[MÉDIO-ALTO] `fetch()` ao PNCP sem timeout nenhum, combinado com cron sem guarda contra sobreposição.** `pncp-client.ts` chamava `fetch(url)` sem `signal`/timeout — se o PNCP aceitasse a conexão e nunca respondesse (ou respondesse muito devagar), a chamada ficava sujeita só ao timeout default do undici (minutos), não a um limite deliberado do produto. Com até 6 tentativas reais por modalidade (5 retries + a que estoura o limite) x 15 modalidades processadas **sequencialmente**, um job de ingestão sob PNCP instável podia em tese ultrapassar o intervalo de 15min do próprio cron. E o `scheduler.ts` (`node-cron`) **não tem guarda nenhuma contra execução sobreposta** — por padrão ele dispara no relógio de parede independente da promise anterior já ter resolvido. Duas execuções concorrentes de ingestão dobrariam a taxa efetiva de requests contra o PNCP (violando o 1 req/s pretendido, Notas de Execução #1) e correriam risco de corrida na leitura-então-escrita do estado global `state#global` em `RateLimitMetrics`. **Corrigido em duas frentes**: `AbortSignal.timeout(15_000)` em toda chamada `fetch()` (`pncp-client.ts`, trata o estouro pelo mesmo caminho de erro de rede/backoff já existente, sem mudar a interface) + trava de exclusão mútua em `scheduler.ts` (`runExclusive`, flag em memória compartilhada entre a ingestão incremental e a reconciliação semanal — as duas competem pelo mesmo recurso PNCP e pelo mesmo estado global, então usam a mesma trava; se uma tentar rodar enquanto a outra está em andamento, é pulada com log, não enfileirada). Verificado com `npx tsc --noEmit` limpo e teste novo confirmando que todo `fetch()` agora recebe um `AbortSignal`.
2. **[MÉDIO] Checkpoint corrompido travava a ingestão incremental pra sempre, sem autocorreção.** `getCheckpoint()` (`ingestion.service.ts`) lia `last_processed_date` de `Checkpoint` e usava o valor cru, sem validar formato — só tratava o caso de checkpoint **ausente** (primeira execução). Se o valor virasse algo fora do padrão `YYYYMMDD` (ex.: editado à mão via `dynamodb-admin`, GUI que o próprio `docker-compose.yml` deste projeto expõe na porta 8001, ou por um bug futuro em outro ponto do código), essa mesma data inválida seria reenviada ao PNCP em **toda** execução futura do cron, indefinidamente, sem nenhum jeito de auto-recuperação — diferente do caso "falha de modalidade" (que já tem retry saudável porque a janela de datas continua válida). **Corrigido**: validação de formato (`/^\d{8}$/`) em `getCheckpoint()`; um checkpoint fora do padrão é descartado com log de erro e tratado exatamente como "sem checkpoint" (recomeça de ontem), fechando o loop de autocorreção.
3. Nenhum bug de perda de dado, race condition de escrita concorrente em `Tenders`/`Checkpoint`, ou divergência de comportamento vs. o que o PLAN.md descreve como "verificado ao vivo" nas Rodadas 1/5 foi encontrado — a lógica de dedupe por `pncp_control_number` (upsert), o "checkpoint só avança se todas as modalidades tiverem sucesso", e o "rate-limit-tracking nunca lança mesmo com falha de gravação" **bateram exatamente com o que o PLAN.md já afirmava**, agora com teste automatizado formal fechando a garantia (ver abaixo) em vez de só inspeção de código/verificação manual anterior.

**Nenhuma discrepância real encontrada entre o comportamento ao vivo relatado nas Rodadas 1/5 e o comportamento do código atual** — os 3 achados acima são gaps não cobertos antes (não contradições do que já tinha sido testado), consistente com o pedido de reportar achado real em vez de só validar.

**Testes novos (Vitest) — 29 no total, todos passando, nenhum teste antigo quebrado:**
- **`src/tenders/rate-limit-tracking.test.ts` (NOVO, 13 testes)** — módulo que antes tinha ZERO cobertura formal, apesar de ser explicitamente "requisito de design da Rodada 1" (nunca lançar mesmo com DynamoDB indisponível). Cobre: `recordRateLimitAttempt` resolve sem lançar quando **toda** chamada ao DynamoDB rejeita, quando só a leitura do estado global falha, e quando só a gravação do evento bruto falha (3 variantes da garantia formal pedida); `checkRateLimitAnomaly` resolve sem lançar com DynamoDB indisponível; `getRateLimitSummary` com base vazia (projeto recém-instalado) retorna estrutura zerada/nula corretamente; agregação real de `last24Hours`/médias a partir de buckets mockados; heurística de anomalia disparando (pico real ≥5 e ≥3x a média) e não disparando (abaixo do piso, ou pico que não atinge 3x a média mesmo acima do piso); construção correta do `UpdateExpression` do estado global em 4 cenários (primeiro 429 sem streak anterior, 429 subsequente com streak em andamento acumulando intervalo, sucesso fechando streak e somando tempo-até-normalizar, sucesso sem streak anterior não gerando nenhum `UpdateCommand` pro estado global).
- **`src/tenders/reconciliation.service.test.ts` (NOVO, 3 testes)** — módulo também sem cobertura antes: janela de 30 dias calculada corretamente (hoje-30 até hoje), resultado de `ingestWindow` repassado sem transformação, erro de `ingestWindow` propagado (reconciliação não engole silenciosamente).
- **`src/tenders/pncp-client.test.ts` (+7 testes, antes só testava `normalizeTender`)**: `fetchContratacoesAtualizacaoPage` com `fetch` mockado (fake timers pra não esperar os delays reais de backoff) — sucesso na 1ª tentativa, `AbortSignal` de timeout presente em toda chamada (valida o fix #1), 204 retorna `null`, 422 lança imediatamente sem retry, 429 aciona backoff exponencial e sucede na 2ª tentativa, erro de rede/timeout aciona o mesmo caminho de retry, e falha persistente (503 contínuo) lança depois de exatamente 6 tentativas reais de fetch (5 retries + a que estoura `MAX_RETRIES`).
- **`src/tenders/ingestion.service.test.ts` (+6 testes)**: paginação real avançando por 3 páginas com verificação da sequência exata de argumentos por chamada; resposta `200` com `data: []` (diferente de `204`/`null`) tratada como fim legítimo de paginação; **todas** as modalidades falhando ao mesmo tempo (não só uma) — confirma `written:0`, port nunca chamado, nenhum `PutCommand` em `Tenders`, e que a checagem de anomalia ainda roda mesmo com falha total; checkpoint corrompido (`"nao-e-uma-data"` e `"2026-01-01"`, formato com hífen) descartado com log de erro e fallback pra ontem (valida o fix #2); checkpoint válido passa direto sem acionar o fallback.

**Avaliado e decidido não mexer (com motivo):**
- Reordenar o `track()` de sucesso em `pncp-client.ts` pra depois do `response.json()` (hoje grava "200/sucesso" antes de confirmar que o corpo é JSON válido — se o PNCP um dia devolver `200` com corpo malformado, a métrica de rate-limit registraria sucesso indevidamente nesse evento raríssimo). Avaliado e descartado: mover pra depois faria uma falha de parse ficar sem NENHUM evento de telemetria gravado (pior pra observabilidade que um evento "sucesso" ligeiramente impreciso num caso que nunca ocorreu em produção até agora). Sem um caminho claramente melhor, não mexi — documentado aqui pra rodada futura decidir com mais contexto se isso realmente importar.
- **Pendência do PLAN.md que continua não fechada por este trabalho**: "Teste de reconciliação com item sintético propositalmente omitido" (topo do arquivo, lista de pendências) é um teste de integração contra DynamoDB Local **real** (comportamento ao vivo, não lógica pura mockável) — os 3 testes novos de `reconciliation.service.test.ts` cobrem a lógica de cálculo de janela/delegação em isolamento (mockando `ingestWindow`), não substituem esse teste de integração específico. Continua pendente, sem mudança de status.

**Evidência de verificação:**
- `npx tsc --noEmit`: limpo.
- `npm test`: **122/122 testes passando** (93 herdados da Rodada 5 + 29 novos desta rodada), incluindo todos os arquivos de teste pré-existentes intactos (`keyword-match`, `query-validation`, `ssrf-guard`, `hmac`, `circuit-breaker`, `pncp-client`, `ingestion.service`).
- Todos os testes novos rodam isolados de infraestrutura real (DynamoDB/rede/`node-cron` mockados via `vi.mock`/`vi.stubGlobal`, `fetch` fake com `vi.useFakeTimers()` pra não esperar os delays reais de backoff), consistente com a decisão de escopo já registrada na Rodada 5 (suíte cobre lógica pura/isolável, não smoke test ponta a ponta).

### 🆕 Rodada 5 de 5 (ÚLTIMA) — Qualidade, testes automatizados e polish final (2026-09-07)

Foco: suíte de testes automatizados real (item #2 das 10 sugestões, até aqui só verificação manual), revisão de consistência cruzada entre as 4 rodadas anteriores (cada uma rodou isolada, sequencial, sem se ver), `npm audit`, e limpeza pontual. Não tocou `src/billing/nfse-payload.ts` (Seção 12, investigação fechada) nem Fase 7/8.

**Achado real de consistência cruzada encontrado e corrigido (prioridade sobre feature nova, como pedido):**
- **`POST /v1/filters/:id/test` e `POST /v1/filters/:id/reactivate` (`src/webhook/webhook.router.ts`) não tinham `clientRateLimit` aplicado** — toda outra rota autenticada da API (tenders, filtros, `/mcp` desde a Rodada 3) aplica o limite por minuto logo após `authenticate`; essas duas rotas, adicionadas na Rodada 4, ficaram de fora — mesma classe de gap que a Rodada 3 já tinha corrigido em `/mcp`. Corrigido e **testado ao vivo**: `X-RateLimit-Limit`/`X-RateLimit-Remaining` confirmados nas duas rotas (plano pro, 600/min, contador decrementando a cada chamada).
- **`docs/openapi.yaml` estava desatualizado**: `/v1/filters/{id}/test` e `/v1/filters/{id}/reactivate` (ambas da Rodada 4) nunca foram documentadas. Adicionadas (bump pra versão `0.3.0`).
- **Vulnerabilidade nova em `npm audit`** (não coberta pela varredura da Seção 11, surgiu depois): `qs@6.15.3` (dependência transitiva de `express`/`body-parser`, usada no parse de `req.query` — caminho real, alcançável por qualquer cliente via query string) tinha 2 avisos moderados sem fix automático dentro do range aceito pelo `express@4.x`. Corrigido via `overrides` no `package.json` forçando `qs@^6.16.0` (a versão que resolve, sem quebrar nada — reconfirmado com `npx tsc --noEmit` + suíte de testes). Resta só a cadeia `node-cron→uuid` já deliberadamente deferida (decisão da Seção 11, breaking change, não resolvida de novo como instruído).
- **Comentários `eslint-disable-next-line` obsoletos** em `server.ts`, `mcp.router.ts` e `common/auth/types.ts` — resíduo de um linter que nunca chegou a ser configurado no projeto (sem `eslint` no `package.json`, sem `.eslintrc`). Removidos.

**Implementado:**
- **Suíte de testes automatizados real (Vitest)**: `npm test` (`vitest run`), **93 testes em 7 arquivos**, cobrindo a lógica mais crítica e mais frágil a regressão, isolada de infraestrutura real (DynamoDB/rede mockados via `vi.mock`, nunca contra o DynamoDB Local):
  - `src/common/keyword-match.test.ts` (8 testes): match por substring, acento em ambas direções, `objeto` vazio/`keywords_tokenized` ausente sem lançar.
  - `src/common/query-validation.test.ts` (35 testes): toda função de validação de query param (`uf`, multi-UF, `limit`, `sort`, range de data, range de valor, `webhook_url`, `stableParamsKey`) — inclui os casos que motivaram bugs reais em rodadas anteriores (`?limit=abc`, `dataInicial` sem `dataFinal`, `valorMin > valorMax`).
  - `src/webhook/ssrf-guard.test.ts` (20 testes): `isBlockedIp` pura pra **IPv4 e IPv6** (RFC1918, CGNAT, loopback, `169.254.169.254`, `fc00::/7`/ULA incluindo o metadata real da AWS `fd00:ec2::254`, `fe80::/10`, mapeamento `::ffff:a.b.c.d`) + `resolveAndAssertSafe` com `dns.lookup` mockado (multi-A-record, falha de DNS).
  - `src/webhook/hmac.test.ts` (6 testes): determinismo da assinatura HMAC, segredo CSPRNG único por chamada.
  - `src/webhook/circuit-breaker.test.ts` (10 testes, `ddbDocClient` mockado): incremento sem desativar, desativação + `opsAlert` ao atingir o limite, não duplicação sob corrida concorrente (achado da Seção 11), filtro já deletado não lança, `reactivateFilter` só aceita filtro de fato desativado (`FilterNotDisabledError` no caso contrário).
  - `src/tenders/pncp-client.test.ts` (6 testes): `normalizeTender` com payload completo, tokenização sem acento/minúscula/tokens curtos filtrados, nunca lança com payload vazio ou campos `null` (Risco #2 do PLAN.md).
  - `src/tenders/ingestion.service.test.ts` (8 testes, `ddbDocClient`+`pncp-client`+`rate-limit-tracking` mockados): dedupe via upsert por `pncp_control_number`, item sem `pncp_control_number` é pulado sem interromper o loop, **falha de uma modalidade isolada das demais** e **checkpoint só avança quando todas as modalidades têm sucesso** (os dois achados críticos da Seção 11, agora com teste automatizado formal — antes só verificação manual), primeira execução sem checkpoint começa de ontem.
  - Decisão de escopo: não testei rotas Express fim-a-fim (`supertest`) nem o servidor MCP — a suíte cobre a lógica pura/isolável mais crítica, como pedido; smoke test ponta a ponta contra servidor real feito manualmente (ver abaixo). Candidato de rodada futura se o projeto crescer.
- **`tsconfig.json`: `noUnusedLocals`/`noUnusedParameters` habilitados** — projeto já passava limpo com essas flags (confirmado antes de habilitar), agora vira guarda-rail permanente contra import/variável morta se acumulando em rodadas futuras.
- **`.env.example`**: adicionado `WEBHOOK_MAX_CONSECUTIVE_FAILURES` (opcional, tinha default no código mas não estava documentado).

**Avaliado e não encontrado (checado, sem achado):** `create-tables.sh` (genérico sobre `table-defs/*.json`, já cobre as tabelas novas das Rodadas 1/4 automaticamente, nenhum ajuste necessário); nomenclatura de código de erro (`{error:{code,message}}`) consistente em toda rota REST/webhook/MCP nas 4 rodadas; `console.log` remanescentes (todos são log estruturado com prefixo `[modulo]`, filosofia de logging do projeto, não lixo esquecido); `TODO`s no código (só 1, já rastreado no PLAN.md, Fase 7/SES).

**Evidência real de verificação (servidor local rodando de verdade, DynamoDB Local real, não mock):**
- `npx tsc --noEmit` limpo (reconfirmado depois de toda mudança, inclusive com `noUnusedLocals`/`noUnusedParameters` novos).
- `npm test`: **93/93 testes passando**.
- `npm audit`: de 5 avisos moderados (incluindo o novo achado de `qs`) pra **2 moderados** (só `node-cron→uuid`, deliberadamente deferido).
- Processo órfão de uma rodada anterior (`tsx src/tenders/run-ingestion.ts` rodando havia mais de 50min) identificado e finalizado antes de iniciar o trabalho, sem afetar containers Docker (`dynamodb-local`/`dynamodb-admin` seguiam saudáveis, 3h de uptime).
- Servidor subido localmente sem instabilidade (ao contrário do relato da Rodada 4 — ambiente menos disputado desta vez): `GET /health` → 200 com `dependencies.dynamodb: "ok"`.
- `GET /v1/tenders?uf=GO&limit=2` → 200 com dado real (3400+ tenders na base).
- `POST /v1/filters` com `webhook_url` malformada → 400 `VALIDATION_ERROR`; com dados válidos (incluindo webhook apontando pra `127.0.0.1`) → 201, filtro real criado.
- `POST /v1/filters/{id}/test` → 202 `queued`, **e o log real do servidor confirma o SSRF guard bloqueando o disparo** (`[webhook-queue] disparo bloqueado por SSRF | ... IP resolvido bloqueado: 127.0.0.1`) — ciclo completo de criação → disparo → bloqueio observado numa única execução viva.
- `X-RateLimit-Limit`/`X-RateLimit-Remaining` confirmados em `/v1/filters/{id}/test` e `/v1/filters/{id}/reactivate` (fix desta rodada, antes ausentes).
- `GET /internal/rate-limit-metrics` → 200 com dado real agregado.
- `POST /webhooks/asaas` sem token → 403 `FORBIDDEN`, formato de erro padronizado confirmado.

### 🆕 Rodada 4 de 5 — Webhook/billing: durabilidade e confiabilidade de produção (2026-09-07)

Foco: `src/webhook/` e `src/billing/` prontos pra alguém pagando de verdade por isso — durabilidade da fila, reconciliação de plano, alerta estruturado, formato de erro consistente. Não tocou `src/billing/nfse-payload.ts` nem nada do payload/campos fiscais do Focus (Seção 12, investigação fechada). Não mexeu em Fase 7/8.

**Bugs reais encontrados e corrigidos (prioridade sobre feature nova, como pedido):**
- **Bug de negócio grave (perda de receita ativa): o webhook do Asaas só tratava confirmação de pagamento (upgrade), nunca reversão financeira.** Um estorno (`PAYMENT_REFUNDED`), chargeback (`PAYMENT_CHARGEBACK_REQUESTED`/`_DISPUTE`) ou cobrança deletada (`PAYMENT_DELETED`) não mudava `plan_tier` nenhum — o cliente continuava com acesso Pro/Starter de graça pra sempre depois de reaver o dinheiro. Corrigido: esses eventos agora rebaixam pra Free (`downgradeToFreeForAsaasCustomer`, `src/billing/customer-plan-sync.ts`) com alerta `critical`. **Testado ao vivo de ponta a ponta**: cliente de teste `pro` → evento `PAYMENT_REFUNDED` real via HTTP → `plan_tier` virou `free` confirmado por leitura direta do DynamoDB; reenvio do mesmo evento confirmado idempotente (`downgraded:false`, sem escrita/alerta duplicado). `PAYMENT_OVERDUE` tratado só como alerta (decisão deliberada: cortar acesso na primeira falha de cobrança recorrente é agressivo sem uma janela de tolerância/dunning, que não existe ainda — documentado no código).
- **Circuit breaker sem caminho de recuperação**: uma vez que um filtro era desativado por excesso de falhas consecutivas (`src/webhook/circuit-breaker.ts`), não existia NENHUMA rota (nem HTTP, nem MCP) pra reativar — o cliente que corrigisse o próprio endpoint ficava com o filtro morto pra sempre, único jeito era deletar e recriar (perdendo o histórico de `WebhookDeliveryLog`, indexado por `filter_id`). Corrigido com `POST /v1/filters/:id/reactivate` (`reactivateFilter`, IDOR-safe, `ConditionExpression` pra só aceitar reativar um filtro de fato desativado). **Testado ao vivo**: 5 disparos reais contra um filtro com URL SSRF-bloqueada → `consecutive_failures=5`, `active=false` confirmado → `POST .../reactivate` → `active=true`, `consecutive_failures=0` confirmado → reativar de novo → `409 FILTER_NOT_DISABLED` corretamente.

**Implementado:**
- **Fila de webhook durável (item #5 do PLAN.md)**: `src/webhook/webhook-delivery-queue.repository.ts` (tabela nova `WebhookDeliveryQueue`, PK `delivery_id`) + `in-memory-webhook-queue.adapter.ts` agora grava a intenção de entrega ANTES de tentar despachar e só remove o registro ao final (sucesso ou esgotamento de tentativas). Se o processo morrer no meio de uma entrega, o registro sobrevive. `src/webhook/webhook-queue-recovery.ts` roda uma vez no boot (`server.ts`, fire-and-forget, não atrasa `/health`) e reenfileira qualquer item órfão de um processo anterior, relendo o `secret` de `SavedFilters` (nunca duplicado na fila durável). Não substitui SQS real (Fase 7) — fecha o gap concreto de hoje (perda em restart) sem essa complexidade. **Testado ao vivo de forma direta via inspeção do DynamoDB**: item persistido em `WebhookDeliveryQueue` ANTES do disparo (confirmado via leitura da tabela durante um disparo real contra IP não roteável), processo morto no meio do disparo (queda real do processo no ambiente de teste — ver limitação abaixo), registro confirmado sobrevivendo no DynamoDB após a queda, e log real de recuperação no boot seguinte: `[webhook-queue-recovery] 1 entrega(s) pendente(s) de um processo anterior, recuperando...`. O ciclo completo até a remoção do registro (sucesso/esgotamento) não pôde ser observado até o fim nesta rodada por instabilidade do ambiente compartilhado (ver limitação), mas persistência-antes-do-disparo e recuperação-no-boot estão confirmadas com evidência direta do banco, não só leitura de código.
- **Reconciliação periódica de billing via API real do Asaas (Risco #13 do PLAN.md)**: `src/billing/asaas-client.ts` (cliente mínimo, só GET, `ASAAS_API_KEY_PROD`) + `src/billing/reconciliation.service.ts` (`reconcilePlanTiers`, escopo deliberadamente limitado a sincronizar `plan_tier` a partir de pagamentos `CONFIRMED`/`RECEIVED` dos últimos 3 dias — não reemite NF-e, não cobre estorno/chargeback aqui, que já é tratado em tempo real pelo webhook). Registrado no `scheduler.ts` a cada 30min. **Testado ao vivo contra a API REAL de produção do Asaas** (só leitura): `npx tsx scripts/run-reconciliation-once.ts` → `{"checked":0,"driftFound":0,"driftFixed":0,"errors":0}` (sem drift real no momento do teste, esperado); teste do caminho de erro com `ASAAS_API_KEY_PROD` inválida sobrescrita só no processo do script → `errors:2`, `opsAlert` disparado corretamente pros dois status (`CONFIRMED`/`RECEIVED`), sem crash.
- **Alerta operacional estruturado (item #4 do PLAN.md)**: `src/common/ops-alert.ts` (linha JSON única, `severity`+`event`+contexto, pronta pra virar CloudWatch Metric Filter na Fase 7 sem retrabalho). Aplicado em: circuit breaker aberto (`webhook_filter_circuit_breaker_open`, warning), downgrade de plano por estorno/chargeback (`billing_plan_downgraded`, critical), `PAYMENT_OVERDUE` (`billing_payment_overdue`, warning), falha de emissão de NF-e (`billing_nfse_emission_failed`, critical), falha de autorização reportada pelo callback do Focus (`billing_nfse_authorization_failed`, critical — sem mexer no payload/lógica do Focus em si), falha de reconciliação (`billing_reconciliation_fetch_failed`/`_sync_failed`, warning) e drift corrigido pela reconciliação (`billing_reconciliation_drift_fixed`, warning). **Testado ao vivo**: todos os eventos acima confirmados aparecendo no log real do servidor durante os testes desta rodada.
- **Formato de erro padronizado `{error:{code,message}}`** estendido pra `webhook.router.ts`, `asaas-webhook.router.ts` e `focus-webhook.router.ts` — fecha a lacuna documentada na Rodada 2 ("billing/webhook ainda respondem no formato antigo"). **Testado ao vivo**: 403 sem token (Asaas e Focus), 400 de payload malformado, 404 de filtro inexistente (`/test` e `/reactivate`), 409 de reativação redundante — todos no formato novo, confirmados via curl real.
- **Validação de entrada mais rigorosa no webhook do Asaas**: `isValidPayment` (`asaas-webhook.router.ts`) rejeita com `400 VALIDATION_ERROR` um `payment.value` não-numérico ou `payment.id`/`payment.customer` ausente, antes de chegar em `planByPriceBrl`/emissão de NF-e. **Testado ao vivo**: `value` como string e `customer` ausente, ambos rejeitados com 400 no formato padronizado.
- Tabela nova `WebhookDeliveryQueue` (`scripts/table-defs/webhook-delivery-queue.json`) — `create-tables.sh` já é genérico (loop sobre `table-defs/*.json`), não precisou mudar; criada e confirmada via `aws dynamodb list-tables` contra o DynamoDB Local.
- `scripts/run-reconciliation-once.ts` (novo, permanente): utilitário de dev pra disparar a reconciliação de billing manualmente sem esperar os 30min do cron — mesmo padrão de `scripts/create-test-api-key.ts` já existente no projeto.

**Avaliado e decidido NÃO fazer nesta rodada (com motivo):**
- **Reconciliação de estorno/chargeback via polling** (além do webhook em tempo real já corrigido): avaliei consultar a API do Asaas por status `REFUNDED`/`CHARGEBACK_*` periodicamente também, mas isso exigiria decidir uma janela de "confiança" (quanto tempo depois de um estorno é seguro rebaixar via polling, dado que o webhook em tempo real já cobre o caso comum) sem um critério claro ainda — adiado, documentado no código (`reconciliation.service.ts`).
- **Reemissão de NF-e dentro da reconciliação**: decidido explicitamente NÃO reemitir NF-e quando a reconciliação encontra um pagamento confirmado sem invoice local — risco real de nota fiscal duplicada pro mesmo pagamento (o webhook original pode só ter falhado em atualizar `plan_tier`, não necessariamente em emitir a nota). Reconciliação cobre só `plan_tier`, por design.
- **SES real pro alerta** (item #4 do PLAN.md): `opsAlert` já deixa o formato estruturado pronto, mas o transporte continua sendo log (stderr) — implementar SES de verdade exigiria sair do sandbox (Fase 0.3, ainda pendente) e é natural da Fase 7, não desta rodada de robustez local.

**Limitação honesta desta rodada — instabilidade do ambiente de teste compartilhado**: a máquina local está rodando ~90 processos `node.exe` simultâneos (várias sessões de agente em paralelo nesta mesma tarefa — `docker compose`/DynamoDB Local + processos de outras rodadas), alguns consumindo >1.6GB de RAM. Durante os testes desta rodada o processo do servidor morreu repetidamente e sem stack trace (nem em `stdout`, nem em `stderr` redirecionados), inclusive quando iniciado totalmente desacoplado da sessão de shell (via Tarefa Agendada do Windows) — comportamento consistente com o processo sendo derrubado externamente por pressão de recursos da máquina compartilhada, não com uma exceção não tratada no código. Isolei o código de rede/timeout do dispatcher (`webhook-dispatcher.ts`) num script standalone fora do Express e ele funcionou perfeitamente (timeout disparado em 5s, erro capturado, saída limpa) — evidência de que a lógica de dispatch em si não é a causa. Por causa disso, o ciclo completo "fila durável → disparo real que falha por timeout de rede → remoção do registro ao final" foi confirmado por partes (persistência antes do disparo + recuperação no boot, ambos via inspeção direta do DynamoDB) mas não observado numa única execução ininterrupta do processo até o fim. Recomendo à próxima rodada (ou revisão futura) reexecutar esse teste específico num ambiente menos disputado se quiser a confirmação ponta a ponta num único processo vivo.

### 🆕 Rodada 3 de 5 — Servidor MCP: valor e robustez pro fornecedor não-técnico (2026-09-07)

Foco: deixar o servidor MCP (`src/mcp/`) útil o bastante pra um fornecedor leigo conversando com Claude/ChatGPT sobre licitações. Rodou sobre o que a Rodada 2 deixou pronto em `tenders.service.ts`/`query-validation.ts` (reusado, não reescrito). Não mexeu em Focus NFe (Seção 12) nem Fase 7/8.

**Bugs reais encontrados e corrigidos (prioridade sobre feature nova, como pedido):**
- **`POST /mcp` não tinha `clientRateLimit`** — toda outra rota autenticada (tenders, filtros) já aplica o rate limit por minuto da Rodada 2 logo após `authenticate`; o MCP era a única rota que ficava de fora, reabrindo a mesma classe de brecha de rajada que a Rodada 2 já tinha fechado no resto da API. **Corrigido e testado ao vivo com rajada real** (ver evidência abaixo).
- **`create_saved_filter` (ferramenta MCP) nunca validava `uf`/`webhook_url`** — diferente de `filters.router.ts` (que a Rodada 2 corrigiu), a versão MCP aceitava qualquer string e só falhava silenciosamente no primeiro disparo do dispatcher (Fase 4). Corrigido reusando `assertValidUf`/`assertValidWebhookUrl` de `query-validation.ts`.
- **`list_my_saved_filters` rodava sem `try/catch`** — diferente de todas as outras ferramentas. Uma falha do DynamoDB ali rejeitava a Promise do handler da rota `/mcp` inteira (500 pra toda a chamada JSON-RPC, não isolado só naquela ferramenta). Corrigido com o mesmo padrão `try/catch` das demais.
- **Erros não-`HttpError` vazavam a mensagem interna crua** (`(err as Error).message`) pro modelo do outro lado (ex.: mensagem de erro do SDK do DynamoDB). Corrigido: helper `toolError()` centralizado — `HttpError` (validação) devolve mensagem PT-BR já amigável; qualquer outro erro devolve mensagem genérica + log no servidor, nunca stack trace/detalhe interno.

**Implementado:**
- **Capacidades da Rodada 2 expostas de verdade em `search_tenders`** (antes só existia um ajuste mecânico pra compilar, sem UX): `uf`/`modalidade` agora aceitam array (até 5 valores), mais `dataInicial`/`dataFinal`, `valorMin`/`valorMax`, `sort`, `cursor` — todos com `.describe()` explicando formato esperado e exemplo, e a `description` da tool ganhou um exemplo de uso completo (multi-UF + keyword + data + valor) pra ajudar o modelo do outro lado a montar a chamada certa.
- **`get_tender_stats`** (nova ferramenta): resumo agregado — quantidade, valor total/médio estimado, quebra por modalidade — sobre a amostra mais recente que combina com um filtro (mesmas regras de `search_tenders`). Responde perguntas tipo "quantas licitações de TI abriram em SP este mês". Amostra limitada a 50 (Free) / 200 (Starter/Pro) — **limitação documentada explicitamente na `description` e na resposta**: não é `Count`/`Scan` da base inteira (proibido pelo plano de arquitetura), é resumo sobre a página mais recente.
- **`delete_saved_filter`** (nova ferramenta): remove filtro salvo por `filter_id`, reusa `deleteOwnedFilter` (já IDOR-safe via `assertFilterOwnership`).
- **`get_filter_deliveries`** (nova ferramenta): histórico de alertas (webhook) já disparados por um filtro, reusa `listDeliveriesForOwnedFilter` (já existia em `filters.service.ts`, só não estava exposto no MCP).
- **`get_usage_stats`** (nova ferramenta): uso mensal do próprio cliente (requisições usadas/limite/restantes) + limite por minuto do plano. Novo `src/mcp/usage.service.ts` (`GetCommand` puro sobre `UsageCounters`, mesma chave que `authenticate` já incrementa — `currentYyyymm` e `REQUESTS_PER_MINUTE` exportados de `api-key.middleware.ts`/`client-rate-limit.ts` pra reusar, não duplicar, a regra de bucket/limite).
- **Respostas formatadas pra leitura humana** (`src/mcp/format.ts`, novo): texto legível em vez de JSON cru — lista numerada com modalidade/órgão/local/valor em BRL/data/link clicável do PNCP; `objeto` truncado em 280 caracteres na listagem (detalhe completo em `get_tender_details`); `raw_payload`/`keywords_tokenized` (campos internos pesados) nunca aparecem na resposta MCP (a API REST já dá acesso ao dado bruto pra quem precisa).
- **Descrições de ferramenta reescritas** em toda a superfície MCP (`search_tenders`, `get_tender_details`, `get_tender_stats`, `list_my_saved_filters`, `create_saved_filter`, `delete_saved_filter`, `get_filter_deliveries`, `get_usage_stats`) com formato esperado, exemplo de uso e quando usar cada uma — objetivo explícito: ajudar o modelo consumidor a escolher parâmetros certos sem tentativa e erro.
- **Enforcement de plano nas tools novas**: `get_tender_stats` usa amostra menor pro Free (50) vs Starter/Pro (200), mesmo critério já usado no teto mensal (`PLANS`) e no rate limit por minuto. `delete_saved_filter`/`get_filter_deliveries`/`get_usage_stats` não têm gate de plano — são leitura/remoção de recurso próprio, sem custo assimétrico por tier (mesmo critério já usado em `GET/DELETE /v1/filters/:id` na API REST, que também não são plan-gated).

**Evidência real de verificação (servidor local reiniciado com o código novo, DynamoDB Local real, teste via SDK oficial `@modelcontextprotocol/{client,node}`, chamada HTTP real contra `POST /mcp`, não leitura de código):**
- `npx tsc --noEmit` limpo.
- 2 clientes de teste seedados em `ApiKeys` (`round3-mcp-pro`/plano pro, `round3-mcp-free`/plano free) com hash SHA-256 real.
- `search_tenders` com `uf: ["GO","SP"], sort: "asc"` → 3 licitações reais mescladas e ordenadas corretamente (multi-UF confirmado ponta a ponta pela primeira vez desde a Rodada 2, que só tinha testado isso via REST).
- `search_tenders` com `uf`+`modalidade` juntos → erro amigável PT-BR (`isError: true`, sem stack trace).
- `search_tenders` com `dataInicial` sem `dataFinal` → erro amigável (reuso de `parseDateRange` confirmado funcionando com input tipado, não só string de query).
- `search_tenders` com `valorMin > valorMax` → erro amigável.
- `search_tenders` com UF inválida (`"XX"`) → erro amigável (`assertValidUf` reusado).
- `get_tender_stats` com `uf: ["GO"]` (plano pro) → resumo real: 134 licitações, R$ 5.267.671.605,93 total, quebra por modalidade correta.
- `get_tender_stats` mesmo filtro no plano **free** → confirmado amostra de exatamente 50 (vs 134 no pro), nota de limitação aparece no texto.
- `get_tender_details` com id inexistente → erro amigável, não crash.
- `get_usage_stats` (pro e free) → contadores reais corretos (`11/50000` pro, `4/100` free) e limite por minuto certo (600 vs 30).
- `create_saved_filter` com `webhook_url` malformada → erro amigável (validação nova confirmada, antes não existia).
- `create_saved_filter` válido → filtro criado de verdade em `SavedFilters` local, `filter_id` real retornado.
- `list_my_saved_filters` antes/depois de criar e depois de deletar → contagem e conteúdo corretos nas 3 chamadas.
- `get_filter_deliveries` (sem entregas ainda, e com `filter_id` inexistente) → ambos os casos corretos.
- `delete_saved_filter` (inexistente → erro amigável; válido → removido de verdade, confirmado via `list_my_saved_filters` depois).
- `create_saved_filter` no plano **free** → bloqueado com mensagem amigável (`PLAN_LIMIT_EXCEEDED` equivalente, enforcement confirmado também no MCP).
- **Rate limit por minuto testado com rajada real contra `/mcp`** (não existia teste disso antes — era exatamente o gap encontrado): requisições em sequência rápida contra `POST /mcp` (plano free, 30/min) → as primeiras responderam `200`, a partir de um certo ponto passaram a `429` de forma consistente. `GET /health` confirmado `200` logo depois (processo não caiu).

**Limitação honesta desta rodada:** `get_tender_stats` resume sobre uma amostra (50/200 itens), não a base inteira — documentado na `description` da tool e na resposta em runtime, não é um bug, é uma decisão de custo (evitar `Scan`/`Count` sobre a base toda). App Claude Desktop literal continua não testado (ambiente headless, mesma pendência da Fase 6.3) — testado via SDK oficial contra o protocolo real, igual à Rodada anterior.

### 🆕 Rodada 2 de 5 — API REST: valor e robustez pro consumidor (2026-09-07)

Foco: deixar `GET /v1/tenders` e as rotas relacionadas robustas e uteis o bastante pra quem for integrar de verdade (ERPs, consultorias, fornecedores tecnicos). Rodou sobre o codigo que a Rodada 1 (rate-limit tracking do PNCP) deixou pronto; nao mexeu nele. Nao tocou MCP server nem billing alem do minimo pra manter tudo compilando (1 ajuste mecanico em `mcp.router.ts`, ver abaixo).

**Bug real encontrado e corrigido (prioridade sobre feature nova, como pedido):**
- **`src/common/auth/api-key.middleware.ts` (`authenticate`) rodava SEM try/catch**, apesar de ser o unico trecho de codigo que executa em 100% das requisicoes autenticadas. Express 4 nao captura rejeicao de Promise em middleware async -- uma falha do DynamoDB aqui (endpoint fora do ar, timeout) derrubava o processo inteiro, a MESMA classe de bug (DoS de uma linha) ja corrigida em toda rota na Rodada 5 da Seção 11, mas que sobrevivia intocada no ponto de maior execucao do sistema. Corrigido com try/catch + `next(err)`, integrado ao middleware global de erro.
- Achado secundario: `?limit=abc` (ou negativo/zero/>100) em `GET /v1/tenders` virava `NaN`/valor invalido passado direto pro `Limit` do DynamoDB `QueryCommand`, sem nenhuma validacao antes. Corrigido com `parseLimit` (400 explicito).
- `dataInicial` sem `dataFinal` (ou vice-versa) era silenciosamente ignorado (o filtro de data so era aplicado se os dois viessem juntos) -- o cliente recebia todos os resultados sem entender por que o filtro nao surtiu efeito. Agora responde 400 explicito.

**Implementado:**
- **Multi-valor em `uf`/`modalidade`** (`GET /v1/tenders`, ate 5 valores separados por virgula, ex. `uf=GO,SP,MG`): `QueryCommand` paralela por valor (mesmo GSI, nao cria indice novo), resultado mesclado e reordenado em memoria. Limitacao honesta e documentada: paginacao via `cursor` nao e suportada nesse modo (custaria complexidade real -- N cursores independentes -- sem valor claro agora; cliente refina o filtro em vez de paginar).
- **Faixa de valor estimado** (`valorMin`/`valorMax`) em `GET /v1/tenders` e `GET /v1/orgaos/{cnpj}/tenders`, filtrado em memoria sobre a pagina do GSI (mesmo padrao ja usado pra `keyword`).
- **Ordenacao configuravel** (`sort=asc|desc`, por `data_publicacao`, `desc` e o padrao -- mesmo comportamento de antes, mudanca aditiva). Ordenacao por `valor_estimado` avaliada e descartada por enquanto: nao ha GSI por valor, um "sort" so dentro da pagina atual seria enganoso (pareceria ordenado globalmente sem estar) -- candidato a melhoria futura se houver demanda real por essa ordenacao.
- **Validacao de query params** centralizada em `src/common/query-validation.ts`: `uf` contra lista real de 27 siglas, `limit` (inteiro 1-100), `sort`, faixa de data (formato + `dataInicial <= dataFinal`), faixa de valor (`valorMin <= valorMax`, ambos >= 0). Reaproveitado tambem por `POST /v1/filters` (valida `uf` e agora tambem `webhook_url` como URL http(s) bem formada na criacao -- antes um valor malformado so falhava, silenciosamente pro cliente, la no primeiro disparo do dispatcher).
- **Rate limiting da propria API pros clientes** (`src/common/client-rate-limit.ts`), distinto do teto MENSAL ja existente (`UsageCounters`): limite POR MINUTO (Free 30, Starter 180, Pro 600), aplicado por rota logo apos `authenticate`, igual ao padrao ja usado nas outras rotas. **Backed por DynamoDB (nova tabela `ClientRateLimits`, `UpdateCommand ADD` atomico, TTL de 2min), nao memoria de processo** -- decisao deliberada: em producao (Fase 7) cada request pode cair numa instancia Lambda diferente, um limitador em memoria local nao enxergaria rajada distribuida entre instancias, entao ja nasce pronto pra Lambda sem retrabalho. Headers `X-RateLimit-Limit`/`X-RateLimit-Remaining` em toda resposta autenticada; estourar responde 429 com `Retry-After`.
- **Cache de resposta curto (30s)** em `GET /v1/tenders`, `GET /v1/tenders/{id}` e `GET /v1/orgaos/{cnpj}/tenders` (`src/common/ttl-cache.ts`, Map em memoria com TTL + eviction simples, sem dependencia nova). Compartilhado entre clientes (dado de tender nao e customer-especifico). Header `X-Cache: HIT|MISS`. Limitacao documentada no proprio codigo: e' cache LOCAL ao processo, nao sobrevive entre instancias Lambda distintas na Fase 7 -- ainda reduz carga real hoje (unico processo) e em rajada dentro de uma instancia quente em producao.
- **Formato de erro padronizado** em toda rota de tenders/filtros/autenticacao: `{ "error": { "code": "...", "message": "..." } }` com `code` estavel (`VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `RATE_LIMITED`, `PLAN_LIMIT_EXCEEDED`, `INTERNAL_ERROR`) em vez de so uma string livre em portugues. `HttpError` ganhou um campo `code`. **Limitacao honesta:** billing/webhook (`asaas-webhook.router.ts`, `focus-webhook.router.ts`, `webhook.router.ts`) ainda respondem no formato antigo (`{error: "string"}`) -- fora do escopo desta rodada por instrucao explicita (nao mexer em billing/MCP alem do necessario); candidato a alinhar numa rodada futura.
- **`GET /health` enriquecido**: `version` (lido de `package.json`), `node_version`, `uptime_seconds`, `timestamp`, e um check real de conectividade com o DynamoDB (`dependencies.dynamodb: "ok"|"error"`, responde 503 com `status: "degraded"` se a dependencia estiver fora do ar). Antes so confirmava que o processo Express estava de pe.
- **`docs/openapi.yaml` (bump pra 0.2.0) e `docs/quickstart.md`** atualizados com todos os parametros novos, os dois niveis de rate limit, o comportamento de cache, o novo formato de erro, e exemplos de curl novos.
- Tabela nova `ClientRateLimits` (`scripts/table-defs/client-rate-limits.json`) + passo de TTL em `scripts/create-tables.sh` (mesmo padrao ja usado pra `RateLimitEvents` na Rodada 1) -- script continua idempotente e generico (loop sobre `table-defs/*.json`).
- Ajuste mecanico em `src/mcp/mcp.router.ts` (unica mudanca fora do escopo de API REST, estritamente pra manter compilando): `searchTenders` passou a aceitar `uf`/`modalidade` como array (suporte a multi-valor); a ferramenta MCP so aceita um valor por vez, entao so empacota num array de 1 elemento -- comportamento exposto ao MCP inalterado.

**Evidencia real de verificacao (servidor local rodando, DynamoDB Local real, nao mock):**
- `npx tsc --noEmit` limpo.
- `bash scripts/create-tables.sh` rodado contra o DynamoDB Local: `ClientRateLimits` criada + TTL habilitado na 1ª vez; reexecutado depois só confirma `SKIP`/tabelas já existentes nas outras 9, sem quebrar nada (idempotência preservada, generico sobre `table-defs/*.json`).
- `GET /health`: `{"status":"ok","version":"0.1.0","node_version":"v24.14.0","uptime_seconds":4,...,"dependencies":{"dynamodb":"ok"}}`.
- `GET /v1/tenders?uf=GO&limit=3`: `X-Cache: MISS` na 1ª chamada, `X-Cache: HIT` na 2ª chamada identica.
- `GET /v1/tenders?uf=GO&limit=abc` → 400 `VALIDATION_ERROR` ("'limit' deve ser um inteiro entre 1 e 100").
- `GET /v1/tenders?uf=XX` → 400 `VALIDATION_ERROR` ("UF invalida: 'XX'...").
- `GET /v1/tenders?uf=GO,SP,MG&limit=5` → 200 com dados reais mesclados de multiplas UFs.
- `GET /v1/tenders?uf=GO,SP&cursor=abc` → 400 `VALIDATION_ERROR` (cursor + multi-valor rejeitado explicitamente).
- `GET /v1/tenders?uf=GO&dataInicial=2026-01-01` (sem dataFinal) → 400 `VALIDATION_ERROR`.
- `GET /v1/tenders?uf=GO&valorMin=1000&valorMax=500` → 400 `VALIDATION_ERROR` (min > max).
- `GET /v1/tenders?uf=GO&sort=asc&limit=2` → 200, ordem ascendente confirmada.
- `GET /v1/tenders?uf=GO&cursor=lixo` → 400 `VALIDATION_ERROR` controlado (nao derruba o processo -- confirmado com `GET /health` logo depois, processo continuava de pe).
- `GET /v1/tenders?uf=GO` sem API key → 401 `UNAUTHORIZED` no novo formato.
- `POST /v1/filters` com `uf` invalida → 400; com `webhook_url` malformada (`"nao-e-url"`) → 400; com dados validos → 201, filtro criado de verdade em `SavedFilters` local.
- `GET /v1/tenders/<id-inexistente>` → 404 `NOT_FOUND` no novo formato.
- **Rate limit por minuto testado com rajada real**: chave de plano `free` (limite 30/min), 35 requisicoes disparadas em sequencia rapida contra `GET /v1/tenders?uf=GO` (query string variando pra nao bater no cache) → as primeiras 30 responderam `200`, as 5 seguintes responderam `429` com `{"error":{"code":"RATE_LIMITED","message":"Limite de 30 requisicoes/minuto excedido para o plano free..."}}` e header `Retry-After`. Servidor confirmado de pe logo depois (`GET /health` → 200).

**Limitacao honesta desta rodada:** o formato de erro padronizado (`{error:{code,message}}`) nao chegou nas rotas de billing/webhook (fora de escopo explicito). O cache de resposta e' local ao processo (nao Redis/ElastiCache) -- documentado no codigo como tradeoff aceito, mesmo criterio ja usado pra outras decisoes de "local primeiro" do projeto.

### 🆕 Rodada de melhoria — Rastreamento de rate limiting do PNCP (2026-09-07, 1ª de 5 rodadas sequenciais)

Foco obrigatório desta rodada: observabilidade empírica do rate limit do PNCP (nunca documentado pela API, só confirmado na prática — Notas de Execução #1). Escopo: zero CDK/IaC, zero mudança na Fase 7/8, Focus NFe intocado.

**Implementado e verificado (não checkbox otimista — evidências abaixo):**

- **`src/tenders/rate-limit-tracking.ts`** (novo): grava toda tentativa de request ao PNCP (sucesso ou falha, não só 429) em duas tabelas DynamoDB novas:
  - `RateLimitEvents` (evento bruto por tentativa: timestamp, modalidade, endpoint, nº da tentativa, status HTTP, se foi 429, delay de backoff aplicado, tempo desde o 429 anterior, tempo até normalizar depois de um streak de 429; **TTL de 14 dias**) — serve só pra forense pontual, nunca é o caminho de leitura de métrica agregada.
  - `RateLimitMetrics` (contadores agregados atualizados atomicamente via `UpdateCommand ADD` na mesma chamada que grava o evento bruto: buckets `daily#{data}`, `hourly#{data+hora}`, `modalidade#{n}#daily#{data}`, mais um item `state#global` com soma/contagem pra calcular intervalo médio entre 429 e tempo médio até normalizar; **sem TTL**, permanente).
  - Decisão de design (por que 2 tabelas, não log em arquivo nem 1 tabela só): perguntas agregadas ("quantos 429 na última hora/dia", "intervalo médio entre 429", "por modalidade/horário") precisam ser O(1)/O(15)/O(24) via `GetItem`/`BatchGetItem` sobre os buckets pré-agregados, nunca reprocessando `RateLimitEvents` bruto (isso seria `Scan`, caro e cada vez mais lento com o tempo). Log em arquivo JSON foi descartado por não ser consultável sem reprocessar tudo toda vez, e por não sobreviver de forma natural a múltiplos processos/Lambdas na Fase 7.
  - `getRateLimitSummary()`: função de leitura, usada tanto pela rota nova quanto pela detecção de anomalia.
  - `checkRateLimitAnomaly()`: heurística simples (hora corrente com ≥5 429 E ≥3x a média das outras 23h da janela de 24h → `console.warn`), chamada ao fim de toda janela de ingestão (`ingestWindow`, cobre tanto o incremental quanto a reconciliação semanal). Nunca lança — observabilidade não pode derrubar a ingestão real.
- **`src/tenders/pncp-client.ts`**: toda tentativa de `fetch` (200, 204, 422, erro de rede, ou qualquer status que cai em backoff) agora chama `recordRateLimitAttempt`. `recordRateLimitAttempt` nunca lança (try/catch interno) — falha ao gravar telemetria não pode quebrar a ingestão de dado real.
- **`src/tenders/rate-limit.router.ts`** (novo) + registrado em `server.ts`: rota `GET /internal/rate-limit-metrics`, sem API key (não é dado de cliente, não conta pra `UsageCounters`/plano — equivalente operacional a `/health`; revisar antes de expor em produção real na Fase 7).
- **Tabelas novas**: `scripts/table-defs/rate-limit-events.json` e `rate-limit-metrics.json`. `scripts/create-tables.sh` já era genérico (loop sobre `table-defs/*.json`, idempotente) — não precisou mudar pra criar as tabelas em si; só foi adicionado um passo extra idempotente pra habilitar TTL em `RateLimitEvents` (`aws dynamodb update-time-to-live`, não faz parte do `create-table` em si).
- **`docs/rate-limiting-strategy.md`** (novo): design de ingestão paralela por múltiplas Lambdas/origens — particionamento por modalidade (partição primária, já é a fronteira natural do loop atual) e por faixa de data (secundária, só se necessário); 3 opções de origem de rede com custo/complexidade (Lambda sem VPC/IP dinâmico → NAT instance → NAT Gateway dedicado por AZ), jitter de largada + `state#global` compartilhado pra evitar que todos os workers tomem 429 juntos; critério explícito de quando ativar (só depois de 1-2 semanas de dado real do `RateLimitMetrics` confirmando que o limite é por IP e que isolar por modalidade/horário não basta sozinho). **Nenhuma infra real criada.**

**Evidência real de verificação:**
- `bash scripts/create-tables.sh` rodado 2x em sequência contra o DynamoDB Local: 1ª vez cria `RateLimitEvents`/`RateLimitMetrics` + habilita TTL, 2ª vez mostra `SKIP` nas duas tabelas e no TTL — idempotência confirmada.
- `npx tsc --noEmit` limpo depois de todas as mudanças (reconfirmado no final, com tudo integrado).
- Job de ingestão real (`npx tsx src/tenders/run-ingestion.ts`) executado contra a API real do PNCP. **Achado real e inesperado no momento do teste (2026-09-07 ~14h UTC): o PNCP não estava devolvendo 429, e sim `503`/`504` e falha de rede intermitentes** (`GET .../contratacoes/atualizacao?...codigoModalidadeContratacao=1...` → `503`, depois `504`, depois erro de rede, depois `503` de novo, mesma URL, backoff exponencial real aplicado: 1000ms/2000ms/4000ms/... conforme esperado). Confirma que o rastreamento **funciona de ponta a ponta com tráfego real**, e já captura um modo de falha do PNCP diferente do 429 documentado nas Notas de Execução #1 (instabilidade de servidor, não rate-limit) — dado novo e genuíno, exatamente o tipo de coisa que essa rodada existia pra capturar. `RateLimitEvents` (11 itens brutos gravados) e `RateLimitMetrics` (buckets `daily#20260907`, `hourly#2026090713`/`hourly#2026090714`, `modalidade#1#daily#20260907`, `modalidade#2#daily#20260907`) todos populados corretamente e consistentes entre si.
- `GET /internal/rate-limit-metrics` testado ao vivo (servidor local real, não mock): retornou JSON com `today`, `last24Hours`, `avgIntervalBetween429Ms`/`avgTimeToNormalizeMs` (`null` nesse teste — nenhum 429 ocorreu, comportamento correto), `byModalidadeToday` (15 entradas, modalidades 1 e 2 com contagem real, as outras 13 zeradas corretamente), `last24HourSeries` e `byHourToday` — schema e agregação corretos.
- Checkpoint de ingestão **corretamente não avançou** (`last_processed_date` permaneceu `20260906`) porque as modalidades atingidas falharam todas as tentativas — comportamento correto e já existente (Fase 2.3/achado crítico da Seção 11), não uma regressão desta rodada. A próxima execução do cron reprocessa a mesma janela sem duplicar (upsert idempotente).

**Limitação honesta:** a heurística de anomalia (`checkRateLimitAnomaly`) hoje só compara contra as últimas 24h (sem baseline histórico de dia-da-semana/hora-do-dia de longo prazo) porque ainda não existe dado histórico suficiente — é suficiente pra sinalizar picos óbvios, não pra detectar padrões sutis; reavaliar quando houver semanas de dado real acumulado.

### 🔴 Bloqueado — NÃO EXECUTAR sem aprovação explícita do usuário nesta conversa

- **Fase 7 (deploy AWS real)**: cria infraestrutura de produção de verdade (custa dinheiro, liga billing/NF-e real). Nada da Fase 7 foi feito ainda.
- **Fase 8.3 (soft launch com clientes reais)** e **8.4 (listagem em marketplace)**: dependem da Fase 7.
- **Fase 8.1 (as "5 conversas" de validação de mercado) pode rodar a qualquer momento**, não depende de nada de código — se ninguém fez ainda, vale perguntar ao usuário se quer que isso ande em paralelo.

### 💡 10 sugestões de melhoria levantadas — status final após as 5 rodadas

1. ⚪ **Pendente.** Fluxo real de cadastro/conta (hoje API key é criada por script de dev; falta linkar `asaas_customer_id` automaticamente no signup).
2. ✅ **Feito (Rodada 5).** Suíte de testes automatizados real com Vitest — `npm test`, 93 testes em 7 arquivos, cobrindo keyword-match, validação de query, SSRF guard (IPv4+IPv6), circuit breaker, HMAC, normalização/dedupe de ingestão. Antes toda verificação era manual.
3. ⚪ **Pendente, decisão deliberada de não reabrir.** Resolver o impasse do Focus/SP definitivamente (chamado de suporte) — afeta LicitaHawk e pster-finance; causa raiz já identificada (Seção 12), fica pra quando `FOCUS_ENV=producao` entrar em uso real (Fase 7).
4. 🟡 **Parcial (Rodada 4).** Transporte do alerta ainda é log estruturado (`opsAlert`, `src/common/ops-alert.ts`), não SES real — formato já pronto pra virar CloudWatch Metric Filter/SES sem retrabalho quando a Fase 7 sair do sandbox do SES (Fase 0.3).
5. ✅ **Feito (Rodada 4).** Fila de webhook agora persiste em DynamoDB (`WebhookDeliveryQueue`) antes de despachar e recupera itens órfãos no boot (`webhook-queue-recovery.ts`) — não é SQS real (isso continua Fase 7), mas fecha o gap de perda em restart.
6. ⚪ **Pendente.** Painel web mínimo pro cliente (uso, filtros, faturas).
7. ⚪ **Pendente.** Busca por keyword melhor (fuzzy/stemming, hoje é substring simples — já com teste automatizado cobrindo o comportamento atual, Rodada 5, o que facilita trocar a implementação com segurança no futuro).
8. ⚪ **Pendente.** Backoff mais esperto contra rate-limit do PNCP (cache curto, jitter) — a Rodada 1 deixou a observabilidade (`/internal/rate-limit-metrics`) que qualquer rodada futura precisa pra decidir isso com dado real.
9. ⚪ **Pendente.** Landing page + página de preço (Fase 8.2 do plano original).
10. ⚪ **Pendente.** Testar de verdade com o app Claude Desktop instalado (ambiente de desenvolvimento é headless em todas as 5 rodadas; testado via SDK oficial/protocolo real desde a Fase 6.2, o que cobre a lógica mas não a experiência real do app).

### Como validar este ledger antes de confiar nele

1. Rode `docker compose ps` em `licitahawk/` — se os containers `dynamodb-local`/`dynamodb-admin` não estiverem no ar, suba com `docker compose up -d` (dado é persistente, sobrevive a restart).
2. Rode `npx tsc --noEmit` — deve compilar limpo.
3. Rode `npm test` — deve passar 224/224 (Rodada 10; não precisa do Docker no ar, todos os testes mockam DynamoDB/rede).
4. Suba o servidor (`npx tsx src/server.ts`) e confirme `GET /health` → 200.
5. **Nunca marque um item `[x]` como concluído sem rodar o critério de aceite correspondente (Seção 4) de verdade.** Esta sessão já foi pega uma vez com checkbox otimista demais (ver Seção 10, achado #1) — não repita o erro.
6. Ao terminar qualquer trabalho novo, **atualize esta seção de Status Atual** (não só os checkboxes da Seção 3) — é o que permite a próxima pessoa/IA continuar sem reconstruir contexto do zero.

### Notas de Execução (achados técnicos específicos do PNCP, não previstos no plano original)

1. **Risco #1 do plano CONFIRMADO empiricamente**: depois de várias rodadas de teste no mesmo dia, a API do PNCP passou a devolver `429` persistente por ~20-30min, voltando ao normal sozinha depois. O backoff exponencial (1s/2s/4s/8s/16s, 5 tentativas) + try/catch por modalidade absorveram isso sem derrubar nenhum job.
2. `codigoModalidadeContratacao` é **obrigatório** nos endpoints `/v1/contratacoes/{publicacao,atualizacao}` do PNCP (a doc OpenAPI marca `required: true` no schema mas não explica em prosa nem lista valores válidos). Os 15 códigos válidos são `1` a `15` sem exceção — cuidado, um 422 de range de data >365 dias é facilmente confundido com "modalidade inválida".
3. Ingestão incremental usa o endpoint `/v1/contratacoes/atualizacao` (não `/publicacao`) — `dataAtualizacaoGlobal` cobre contratação nova E atualizada.
4. Try/catch por modalidade dentro do job de ingestão — sem isso, uma modalidade com erro persistente derrubava a janela inteira. Coberto pela reconciliação semanal.
5. `link_pncp` construído como `https://pncp.gov.br/app/editais/{cnpj}/{ano}/{sequencial}` (padrão de URL do portal, não documentado oficialmente).

---

Status: **pending approval** (revisado em múltiplas rodadas — arquitetura, qualidade, segurança, completude, consistência — ver Seções 8, 10, 11, 12; reestruturado para build 100% local antes de qualquer infra AWS real — ver Seção 9)
Escopo: API REST + servidor MCP sobre dados oficiais de licitações públicas do PNCP (Brasil), com webhook de alerta e billing por assinatura.

---

## 1. Requirements Summary

**Produto:** um único backend expondo dois canais:
1. **API REST** para devs (ERPs, consultorias de licitação, fornecedores técnicos): busca de editais normalizada + webhook de alerta por filtro salvo.
2. **Servidor MCP** (mesmo backend): busca conversacional dentro de Claude/ChatGPT para o fornecedor não-técnico.

**Fonte de dado:** exclusivamente a API oficial e estável do PNCP (`pncp.gov.br/api/consulta`, OpenAPI em `/api/consulta/v3/api-docs`). Sem scraping.

**Por que alguém paga por dado público:** o PNCP não tem alerta/notificação (zero), não tem busca global por palavra-chave/UF/valor (é organizado por órgão+ano+sequencial), devolve payload burocrático, e não tem contrato de estabilidade (rate limit não documentado, schema muda sem aviso). O produto vende a camada de conveniência sobre isso — mesma tese que já sustenta concorrentes pagos (Licita Já, ConLicitação, R$180-2.500/mês).

**Diferencial de preço:** segmento "só API/dado puro, sem dashboard", R$49-150/mês.

**Decisões de negócio já travadas:**
- CNPJ já existe → billing pode emitir nota fiscal desde o dia 1.
- Hospedagem final: 100% AWS, sub-conta isolada, **zero CDK/Terraform/SAM/IaC** — infra real via `aws-cli` puro.
- **Build local primeiro**: todo o MVP é escrito e testado 100% na máquina local (Docker + Node), sem criar nenhum recurso AWS além do que já existe (conta, domínio, DNS). A infra real só entra na Fase 7, depois que a lógica já está provada.
- Nota fiscal via Focus NFe, reaproveitando a lógica já validada em produção no `pster-finance` (mesmo CNPJ prestador, mesmo token).

**Fora de escopo do MVP (backlog fase 2):**
- Resultado por item de licitação (dado instável, exigiria scraping).
- Expansão internacional (SAM.gov / TED / UK Contracts Finder).
- Dashboard visual completo.
- Streaming real no MCP (resposta bufferizada — Risco #4).
- Full-text search em escala (OpenSearch) — só entra se o volume justificar.

---

## 2. Decisões de arquitetura (ADR-lite)

| Decisão | Escolhida | Alternativas consideradas | Por quê |
|---|---|---|---|
| Ordem de construção | **100% local primeiro (Fases 1-6), deploy AWS por último (Fase 7)** | Provisionar infra real desde o início, fase a fase | Zero custo de infra enquanto ainda se está validando a lógica; ciclo de teste instantâneo (sem esperar deploy); só se gasta esforço de `aws-cli` uma vez, no final, com o design já estável. |
| Stack de aplicação | Node.js/TypeScript. Local: processo único Express/Fastify. Produção: mesmos handlers, empacotados como Lambda + API Gateway (HTTP API). | Python; rodar Lambda emulado localmente via SAM Local | TS compartilha código entre API, MCP e handlers; lógica de negócio idêntica nos dois ambientes, só a camada de transporte (Express local vs Lambda em prod) muda. SAM Local tem fidelidade imperfeita e complexidade que não compensa pro ganho. |
| Banco de dados | **DynamoDB**. Local: container `amazon/dynamodb-local` via Docker (imagem oficial AWS, mesmo protocolo, suporta tabela/GSI/Query real). Produção: DynamoDB real. | RDS/Aurora Postgres | Zero VPC pra provisionar via CLI puro em produção; local, sobe com um `docker-compose up`, igual a um Postgres local. Trade-off assumido: `amazon/dynamodb-local` **não suporta DynamoDB Streams** — tratado explicitamente no item abaixo. |
| Gatilho de "tender novo → webhook" | **Local:** chamada direta em processo (função `onTenderIngested()` chamada logo após o `PutItem`/`UpdateItem`). **Produção:** DynamoDB Stream real + Lambda event source mapping. Ambos atrás da mesma interface (`TenderIngestedPort`), chamada pelo código de ingestão nos dois ambientes por simetria — mas o adapter de produção é um **no-op**: quem dispara o matcher de verdade em produção é o Stream reagindo à escrita no DynamoDB, não a chamada de `emit()` em si. | Rodar LocalStack só por causa de Streams | LocalStack tem Streams, mas é infraestrutura extra pesada só pra emular uma peça; a interface pequena resolve o mesmo problema com esforço menor. **Trade-off assumido:** o caminho real de Stream só é exercitado de verdade na Fase 7 — ver Risco #17. |
| Fila de disparo de webhook | **Local:** fila em memória simples (array + contador de tentativa, mesmo processo). **Produção:** SQS + DLQ reais. Atrás da mesma interface (`WebhookQueuePort`). | Rodar SQS via LocalStack local | Fila em memória é suficiente pra validar a lógica de retry/circuit-breaker localmente; SQS real só precisa existir quando a durabilidade entre processos importa (produção). |
| Agendador (poller, reconciliação) | **Local:** `node-cron` dentro do processo Node. **Produção:** EventBridge Scheduler real, invocando a mesma função como Lambda. | node-cron também em produção | Em produção, Lambda não é um processo de vida longa — precisa de um agendador externo de verdade (EventBridge). Local, um processo de vida longa com `node-cron` é mais simples que emular EventBridge. |
| Segredos | **Local:** `.env`. **Produção:** SSM Parameter Store (SecureString), nunca variável de ambiente Lambda em texto plano. | Secrets Manager | Mesmo `.env` que já existe hoje serve o ambiente local sem mudança; produção usa SSM por custo (tier gratuito) sem perder segurança (KMS + IAM). |
| Busca por keyword | GSI (UF/modalidade/data/CNPJ) primeiro, filtro de texto em memória depois, **nunca** `Scan` na base toda | OpenSearch desde o início | Válido em ambos os ambientes (DynamoDB Local já suporta GSI igual ao real); gatilho de migração pra OpenSearch se a base ativa passar de ~500k itens. |
| Gateway de pagamento | **Asaas** — nativo BR, Pix, assinatura recorrente | Pagar.me, Stripe | Testável local direto contra a API real do Asaas (sandbox), sem precisar de infra própria. |
| Emissão de nota fiscal | **Focus NFe**, reaproveitando a lógica de `pster-finance/apps/backend/src/focus/` (mesmo CNPJ prestador, mesmo token) | Módulo de NF-e do Asaas | Testável local direto contra `FOCUS_ENV=homologacao` (API real de sandbox do Focus), sem precisar de infra própria. Não é port direto — ver Fase 5.4. Payload alinhado com a config real de produção do pster-finance (Seção 12). |
| Transporte MCP | Streamable HTTP, resposta bufferizada. Local: `http://localhost:PORT/mcp`. Produção: mesma rota via API Gateway + Lambda. | Streaming real via SSE | Testável local com Claude Desktop apontando pro localhost antes de existir qualquer infra AWS. |
| Autenticação de API | API key via `crypto.randomBytes(32)`, hash SHA-256 armazenado | OAuth | Idêntico local e produção — é lógica pura, não depende de infra. |
| Roles IAM (produção) | Uma role por função Lambda, ARN explícito, nunca reaproveitar profile administrativo | Role única compartilhada | Só existe na Fase 7 (não há IAM local); blast radius reduzido se uma Lambda for comprometida. |
| Sessão do servidor MCP | Stateless por request, testado e confirmado (Fase 6.2) | Sessão em memória do processo | Testado localmente com o SDK oficial: `McpServer`+transporte novo a cada requisição HTTP funciona de ponta a ponta, sem precisar de item de sessão em DynamoDB. |

---

## 3. Implementation Steps (fasado)

> **Como ler este plano:** Fases 1-6 rodam **inteiramente na sua máquina**, sem nenhum recurso AWS além do que já existe (conta, domínio). A Fase 7 é a única que cria infraestrutura de produção — e só acontece depois que tudo abaixo já foi testado e funciona, **e com aprovação explícita do usuário**.

### Fase 0 — Fundação de negócio e conta (não-código)
- [ ] 0.1 Sub-conta AWS + profile local — feito, não bloqueia nada abaixo (só é usada na Fase 7).
- [ ] 0.2 Conta Asaas criada. Pendente: chave de **sandbox** (a gravada em `.env` é de produção — rotacionar antes do go-live).
- [ ] 0.3 Domínio `licitahawk.com` comprado, DNS apontado. Pendente: SES + saída do sandbox do SES (só bloqueia a Fase 4.3 rodando contra e-mail real; não bloqueia nada do desenvolvimento local).
- [ ] 0.4 ToS rascunhado. Pendente: dados finais, Política de Privacidade (LGPD), revisão de advogado (só bloqueia publicação real, não o desenvolvimento).

### Fase 1 — Ambiente local
- [x] 1.1 `docker-compose.yml` na raiz do projeto: serviço `dynamodb-local` (imagem `amazon/dynamodb-local`, porta 8000) + `dynamodb-admin` (GUI web, porta 8001). *(verificado: containers sobem e respondem)*
- [x] 1.2 Scaffold do projeto Node/TypeScript: processo Express único servindo todas as rotas que na Fase 7 viram Lambdas separadas. Configuração lê `DYNAMODB_ENDPOINT` do `.env`. *(verificado: `GET /health` responde 200)*
- [x] 1.3 `.env.example` documentando todas as variáveis. *(verificado: `.env` real só recebeu linhas novas, chaves existentes intocadas)*
- [x] 1.4 Interfaces `TenderIngestedPort`/`WebhookQueuePort` definidas. *(implementação real é Fase 4/7; aqui só o contrato + adapter no-op temporário, já trocado pelo real na integração)*

### Fase 2 — Modelagem de dados & ingestão
- [x] 2.1 Schema normalizado de `Tender`: `pncp_control_number` (chave de dedupe), `org_cnpj`, `org_name`, `uf`, `municipio`, `modalidade`, `objeto`, `valor_estimado`, `data_publicacao`, `data_atualizacao`, `situacao`, `link_pncp`, `keywords_tokenized[]`, `raw_payload`.
- [x] 2.2 6 tabelas DynamoDB criadas com GSIs corretos (`Tenders` com GSI1/GSI2/GSI3, `SavedFilters` com GSI uf+modalidade, `ApiKeys` com GSI asaas_customer_id, `UsageCounters`, `WebhookDeliveryLog`, `Checkpoint`) + tabela `Invoices` (Fase 5). Script `scripts/create-tables.sh` idempotente.
- [x] 2.3 Job de ingestão incremental (`node-cron`, 15 min): busca desde o último checkpoint na API real do PNCP, paginação respeitada, 1 req/s, backoff exponencial, dedupe por `pncp_control_number`. **Checkpoint só avança se TODAS as modalidades processarem com sucesso** (corrigido na Seção 11 — antes avançava incondicionalmente, risco real de perda de dado). *(verificado contra API real: 3400+ tenders gravados)*
- [x] 2.4 Job de reconciliação semanal: full scan de janela de 30 dias. *(lógica provada; falta só o teste formal com item sintético omitido, ver Pendências)*

### Fase 3 — API REST ✅
- [x] 3.1 Rotas: `GET /v1/tenders`, `GET /v1/tenders/{id}`, `GET /v1/orgaos/{cnpj}/tenders`, `POST /v1/filters`, `GET /v1/filters`, `DELETE /v1/filters/{id}`, `GET /v1/filters/{id}/deliveries`. IDOR protegido em toda rota com `filter_id`. *(verificado com 2 customers reais)*
- [x] 3.2 Middleware de autenticação: hash SHA-256 de API key, `UsageCounters` atômico. *(verificado sob concorrência real)*
- [x] 3.3 Busca GSI-first, nunca `Scan`. `GET /v1/tenders` sem `uf`/`modalidade` retorna 400 explícito.
- [x] 3.4 Normalização de payload.
- [x] 3.5 `docs/openapi.yaml` + `docs/quickstart.md`.

### Fase 4 — Webhook / alerta ✅
- [x] 4.1 `TenderIngestedPort` real: consulta `SavedFilters` via GSI, testa keyword em memória (`src/common/keyword-match.ts`, compartilhado com a Fase 3).
- [x] 4.2 `WebhookQueuePort` real: HMAC-SHA256, `Idempotency-Key`, timeout 5s, retry com backoff, **SSRF guard completo** (IPv4 privado/CGNAT + IPv6 ULA/link-local/loopback, revalidado a cada disparo, sem seguir redirect). Enqueue é fire-and-forget (não trava o loop de ingestão — corrigido na Seção 11).
- [x] 4.3 Circuit breaker atômico (`ConditionExpression`, sem race condition, sem ressuscitar filtro deletado).
- [x] 4.4 Endpoint `POST /v1/filters/{id}/test` com IDOR e auth aplicados.

### Fase 5 — Billing ✅
- [x] 5.1 Assinatura recorrente + Pix confirmados na doc do Asaas.
- [x] 5.2 Planos Free/Starter(R$49)/Pro(R$149) em `src/billing/plans.ts`, **limites enforced de verdade** (corrigido na Seção 11 — Free não cria webhook).
- [x] 5.3 `POST /webhooks/asaas`: token estático + `timingSafeEqual` + fail-closed, sem bypass de dev. **Pagamento confirmado atualiza `plan_tier` real** (corrigido na Seção 11, testado ao vivo).
- [x] 5.4 Emissão de NF-e via Focus, payload alinhado com produção real do pster-finance (Seção 12), guarda de estado terminal testada com callbacks fora de ordem.
- 🟡 Limitação aceita: `autorizado` em homologação bloqueado pelo sandbox de SP — ver Status Atual no topo.

### Fase 6 — Servidor MCP ✅
- [x] 6.1 8 ferramentas (`search_tenders`, `get_tender_details`, `get_tender_stats`, `list_my_saved_filters`, `create_saved_filter`, `delete_saved_filter`, `get_filter_deliveries`, `get_usage_stats` — as 4 últimas + capacidades multi-UF/valor/data/sort em `search_tenders` adicionadas na Rodada 3), reusando 100% os services da Fase 3/Filtros, **limites de plano também aplicados aqui** (mesmo enforcement da Fase 5.2, corrigido na Seção 11, reforçado na Rodada 3).
- [x] 6.2 Sessão stateless confirmada com teste real (SDK oficial `@modelcontextprotocol/{server,node,client}`, arquitetura modular, não o pacote monolítico antigo).
- [x] 6.3 Handshake via protocolo real testado; app Claude Desktop literal não testado (ambiente headless) — ver Pendências no topo.
- [x] 6.4 (Rodada 3) UX/robustez pro fornecedor não-técnico: respostas em texto legível (não JSON cru), descrições ricas com exemplo em toda ferramenta, erros amigáveis sem stack trace, `clientRateLimit` aplicado em `/mcp` (gap fechado), validação de `uf`/`webhook_url` em `create_saved_filter` (gap fechado) — ver Status Atual no topo, Rodada 3 de 5.

### Fase 7 — Deploy para AWS (única fase que cria infra real) — **NÃO INICIADA, aguarda aprovação**
- [ ] 7.1 Scripts `aws-cli` (reaproveitando os comandos já validados localmente): `create-dynamo-tables.sh`, `create-lambda-role-*.sh` (uma role por função, ARN explícito), `deploy-lambda-*.sh`, `create-apigateway.sh`, `create-sqs-queues.sh`, `create-eventbridge-schedules.sh`, `create-secrets.sh` (SSM Parameter Store).
- [ ] 7.2 Ativar DynamoDB Stream real + Lambda event source mapping. Destino de falha + alarme de `IteratorAge` desde o primeiro deploy.
- [ ] 7.3 Trocar adapters locais (chamada direta/fila em memória) pelos de produção (Stream/SQS real).
- [ ] 7.4 Alarmes CloudWatch + retenção de log em todo log group.
- [ ] 7.5 Dashboard mínimo.
- [ ] 7.6 Teste de carga (k6/artillery).
- [ ] 7.7 Rollback: alias por Lambda + script.
- [ ] 7.8 SES fora do sandbox. `FOCUS_ENV=producao` só depois de validar o fluxo (ver limitação aceita — validação real só acontece aqui).
- [ ] 7.9 Reexecutar contra o ambiente real os testes que só rodavam local (Risco #17).

### Fase 8 — Validação e primeiro cliente
- [ ] 8.1 As "5 conversas" — pode rodar **a qualquer momento**, não depende de código.
- [ ] 8.2 Listagem de produto (nome, preço, 3 screenshots mockados).
- [ ] 8.3 Soft launch para 5-10 beta — só depois da Fase 7.
- [ ] 8.4 Listar em PulseMCP/Glama/Smithery — depois da Fase 7.

---

## 4. Acceptance Criteria (testáveis)

**Local (Fases 1-6, sem depender de infra AWS):**
- [x] `docker-compose up` sobe DynamoDB Local e a aplicação conecta sem erro.
- [x] Job de ingestão roda 2x em sequência manualmente e não duplica `pncp_control_number`.
- [ ] Job de reconciliação captura um item propositalmente omitido do incremental (dado sintético) — pendente, ver Status Atual.
- [x] `GET /v1/tenders?uf=GO&keyword=software` retorna resultado correto usando GSI.
- [x] Webhook de teste chega no endpoint local com HMAC válido e `Idempotency-Key`.
- [x] Cadastro de webhook com URL pra IP privado/`169.254.169.254`/loopback (IPv4 e IPv6) é rejeitado antes do primeiro disparo.
- [x] Circuit breaker desativa filtro após N falhas consecutivas, incremento atômico verificado sob concorrência.
- [x] Cliente A não lê/testa/deleta filtro de Cliente B via `filter_id` adivinhado.
- [x] `POST /webhooks/asaas` sem token correto retorna 403 e não altera `plan_tier` nem dispara NF-e.
- [x] Pagamento confirmado atualiza `plan_tier` real (adicionado na Seção 11, testado ao vivo).
- [x] Cliente Free não consegue criar filtro/webhook; Starter/Pro conseguem dentro do limite (adicionado na Seção 11).
- [ ] Emissão de NF-e em `homologacao` com status `autorizado` — **limitação aceita**, ver Status Atual. Payload já confere com produção real.
- [ ] Ferramenta MCP `search_tenders` respondendo ao **app** Claude Desktop de verdade — pendente (testado via SDK/protocolo, funciona).

**Produção (só depois da Fase 7):**
- [ ] `GET /v1/tenders?...` responde em <500ms p95 sobre base real de **≥100k tenders**, amostra **≥200 requisições**, validado por teste de carga (7.6).
- [ ] `IteratorAge` do event source mapping do matcher tem alarme configurado e testado.
- [ ] Deduplicação de ingestão e reconciliação semanal **reverificadas contra o DynamoDB real** (Risco #18).
- [ ] Handshake do MCP **reexecutado contra o endpoint real** (Risco #4), antes do soft launch (8.3).
- [ ] **Todos** os testes da lista "Local" acima reexecutados contra o ambiente real (Risco #17).
- [ ] Infra inteira reproduzível do zero rodando os scripts `aws-cli` em sequência (idempotentes).
- [ ] Emissão de NF-e em `FOCUS_ENV=producao` chega a `autorizado` de verdade (única forma de fechar a limitação aceita da Fase 5).

---

## 5. Risks and Mitigations

| # | Risco | Mitigação |
|---|---|---|
| 1 | PNCP não tem rate limit documentado, mas bloqueia IP na prática (confirmado empiricamente) | Mínimo 1 req/s, backoff exponencial, polling incremental |
| 2 | Schema do PNCP muda sem aviso entre versões | Validação tolerante a campo ausente + alarme quando campo esperado sumir |
| 3 | Edital republicado gera duplicata | Dedupe por `pncp_control_number` |
| 4 | MCP em Lambda: cold-start + timeout de 30s pode quebrar handshake | Resposta bufferizada; medir latência real antes de vender |
| 5 | DynamoDB `Scan` caro em escala | GSI-first; gatilho de migração a OpenSearch em ~500k itens |
| 6 | Webhook do produto não confiável mina credibilidade | HMAC + idempotency-key + retry + circuit breaker + endpoint de teste |
| 7 | Indisponibilidade do PNCP causa falha de alerta sem culpa do produto | Cláusula de ToS sem reembolso automático |
| 8 | Retenção de ISS varia por município do tomador PJ | Checklist manual mensal no MVP |
| 9 | Zero IaC = risco de drift manual em produção | Scripts `aws-cli` versionados, idempotentes |
| 10 | Webhook do Asaas forjável → upgrade de plano grátis + NF-e falsa | Token estático + `timingSafeEqual` + fail-closed — **corrigido e testado (Seção 11)** |
| 11 | SSRF via webhook do cliente | Bloqueio de ranges privados/link-local (IPv4+IPv6) a cada disparo — **completo (Seção 11)** |
| 12 | IAM excessivamente permissivo em produção | Uma role por função Lambda — só existe na Fase 7 |
| 13 | Webhook do Asaas não entregue → `plan_tier` desatualizado | **✅ Implementado e testado ao vivo na Rodada 4** — `src/billing/reconciliation.service.ts`, job a cada 30min consultando a API real do Asaas (`CONFIRMED`/`RECEIVED` dos últimos 3 dias), reconcilia `plan_tier` de forma idempotente |
| 14 | Falha silenciosa na emissão de NF-e | Alarme CloudWatch + fila de retry manual (produção) |
| 15 | Poison pill trava o DynamoDB Stream do matcher | Destino de falha + alarme de `IteratorAge` — Fase 7.2 |
| 16 | Mercado não valida disposição de pagar | Critério de pivô: <2 de 5 conversas com sinal de compra |
| 17 | Gatilho/fila locais não são o mesmo código que roda em produção | Interfaces pequenas isolam a diferença; testes reexecutados contra ambiente real na Fase 7.9 |
| 18 | DynamoDB Local diverge do real em algo não mapeado | Aceito como trade-off; Fase 7.9 existe pra essa categoria de risco |
| 19 | **[Confirmado, aceito]** Sandbox de homologação do Focus/SP tem impasse de leiaute pra essa inscrição municipal, independente do payload | Payload já alinhado com produção real (Seção 12); validação de `autorizado` fica pra Fase 7 com `FOCUS_ENV=producao` |

---

## 6. Verification Steps

1. `docker-compose up` local, smoke test `curl` em cada rota.
2. Teste de handshake MCP via protocolo real antes de qualquer deploy.
3. Testar forjamento de `POST /webhooks/asaas` local e confirmar 403 sem efeito colateral.
4. Emitir NFS-e de teste em `homologacao` — esperar `erro_autorizacao` por limitação conhecida (Seção 12), não é falha do teste.
5. Testar cadastro de webhook com IP privado (IPv4 e IPv6), confirmar rejeição.
6. Testar IDOR entre dois clientes fictícios localmente.
7. **Só depois da Fase 7**: rodar os scripts `aws-cli` 2x em sequência (idempotentes), reexecutar os itens 3-6 contra o ambiente real, rodar teste de carga, confirmar alarme de `IteratorAge`, e **testar emissão de NF-e em produção de verdade** (única forma de fechar a limitação aceita).

---

## 7. Próximos passos

Fase 7 (deploy AWS) é o próximo passo de infraestrutura, mas **aguarda aprovação explícita do usuário** — não iniciar sem pedir. Fase 8.1 (5 conversas de validação) pode rodar a qualquer momento em paralelo. As 10 sugestões de melhoria (topo desta seção de status) são candidatas a trabalho antes ou depois da Fase 7, a critério do usuário.

---

## 8. Log de revisão — 3 rodadas independentes (arquitetura, qualidade, segurança) — plano ainda não implementado nesse momento

**Arquitetura:** GSI3 ausente pro endpoint por CNPJ; matcher sem índice em `SavedFilters`; sequenciamento de infra; Stream sem alarme de `IteratorAge`; circuit breaker sem operação atômica; sessão MCP em Lambda não endereçada; SES sandbox; esforço de "portar" Focus NFe subestimado; rota `/webhooks/focus` faltando; retenção de log; custo de Secrets Manager vs SSM. **Todos aplicados no plano antes da implementação.**

**Qualidade:** checkboxes `[x]` escondendo pendência real; contradição na seção de verificação; riscos e critérios de aceite faltando pra billing e validação de mercado; passos faltantes (docs de API, teste de carga, rollback). **Todos aplicados.**

**Segurança:** webhook do Asaas forjável (crítico); SSRF no dispatcher; IAM sem least privilege; destino indefinido dos segredos de produção; hash de API key sem especificação; IDOR em rotas por `filter_id`. **Todos aplicados no design.**

---

## 9. Log de reestruturação — build local primeiro

Pedido do usuário: provar a lógica inteira sem criar infraestrutura AWS real, usando Docker localmente, só implantando em produção depois de validado.

- **DynamoDB Local** (`amazon/dynamodb-local`, imagem oficial) substitui o DynamoDB real durante o desenvolvimento.
- **Lacuna real**: DynamoDB Local não suporta DynamoDB Streams. Resolvido com `TenderIngestedPort` (chamada direta local, Stream real em produção).
- Mesma abordagem pra `WebhookQueuePort` (memória local, SQS real) e agendador (`node-cron` local, EventBridge Scheduler real).
- Toda infra real de produção concentrada numa única Fase 7, no final.
- Riscos #17/#18 documentam e aceitam a divergência local/produção.

## 10. Log de revisão — Rodada 4 (consistência pós-reestruturação, ainda em nível de plano)

Verificação de que o rewrite da Seção 9 não deixou referência cruzada quebrada. 3 achados, todos aplicados: critérios de aceite de Produção incompletos (corrigido), resquício de "conta AWS sandbox" de uma versão antiga do plano (removido), `TenderIngestedPort.emit()` precisava de nota explicando que é no-op em produção (adicionado).

## 11. Log de revisão — Rodada 5 (4 lentes pós-implementação: funcional, qualidade, segurança, completude — CÓDIGO REAL, não mais o plano)

Depois que as Fases 1-6 já estavam integradas e reportadas como funcionando, 4 rodadas independentes de revisão sobre o código real (cada agente reteste tudo do zero, sem confiar em relatório anterior). **Todos os achados reais foram corrigidos nesta mesma sessão e re-testados ao vivo.**

**[CRÍTICO] Checkpoint avançava mesmo com falha de ingestão** — `ingestion.service.ts` salvava o checkpoint incondicionalmente mesmo com modalidade falhando (ex.: rate limit). Risco real de perda silenciosa e permanente de dado. **Corrigido:** `ingestWindow` retorna `failedModalidades[]`; checkpoint só avança se vazio.

**[CRÍTICO] Crash de processo via `try/catch` ausente (DoS de uma linha)** — Express 4 não captura rejeição de Promise async automaticamente. Várias rotas sem proteção; `?cursor=lixo` derrubava o servidor inteiro. **Corrigido:** `src/common/async-handler.ts` + middleware de erro global em `server.ts` + `src/common/http-error.ts`. Retestado: cursor inválido agora dá 400, processo continua de pé.

**[ALTO] SSRF: faltava bloquear IPv6 ULA e link-local** — `169.254.169.254` bloqueado mas não `fd00:ec2::254` (equivalente IPv6). **Corrigido:** `isIpv6Blocked` cobre `fc00::/7` e `fe80::/10`. Também `0.0.0.0/8` e `100.64.0.0/10` (CGNAT) no IPv4.

**[IMPORTANTE] Pagamento confirmado nunca atualizava `plan_tier` real** — nota fiscal emitia certinho, mas `ApiKeys` nunca era tocada. **Corrigido:** campo `asaas_customer_id` + GSI + `src/billing/customer-plan-sync.ts`. Testado ao vivo: `starter→pro` confirmado. **Limitação honesta:** não existe fluxo de cadastro que preencha `asaas_customer_id` automaticamente ainda (item #1 das 10 sugestões).

**[IMPORTANTE] Limites de plano nunca eram checados** — Free criava webhook ilimitado de graça. **Corrigido:** enforcement em `filters.router.ts` E `mcp.router.ts` (mesmo buraco nos dois). Testado: Free→403, Starter→201.

**[MÉDIO] Disparo de webhook travava o loop de ingestão inteiro** — `emit()` dava `await` em cada `enqueue()` (~17s pior caso). **Corrigido:** fire-and-forget.

**[MÉDIO] Circuit breaker podia ressuscitar filtro deletado como item fantasma** — `UpdateItem` sem `ConditionExpression`. **Corrigido:** `attribute_exists(customer_id)` nos dois (`recordFailure`/`recordSuccess`).

**[MENOR] Keyword match duplicado com acento inconsistente** — extraído pra `src/common/keyword-match.ts`.

**[MENOR] Comentário obsoleto** em `webhook.router.ts` — corrigido.

**[BAIXO] Dependências com avisos moderados** — `npm audit fix` resolveu o que dava sem breaking change. Resta cadeia `node-cron→uuid`, deferido de propósito.

**[Rastreabilidade] Seção 4 dessincronizada** — narrativa dizia "verificado" mas checkbox formal ficava `[ ]`. Corrigido: sincronizado com evidência real.

Verificação pós-fix: `npx tsc --noEmit` limpo, servidor re-testado ao vivo com tudo junto.

## 12. Investigação e correção do payload Focus NFe — causa raiz identificada, limitação aceita

Usuário confirmou que o `pster-finance` (mesmo CNPJ) já emite nota real com sucesso em produção. Acessei a produção real via túnel SSH (`pster-finance/deploy/prod-db-tunnel.sh`) e confirmei os campos fiscais de **3 notas autorizadas reais**:

| Campo | Produção real (funciona) | LicitaHawk (antes da correção) |
|---|---|---|
| `item_lista_servico` | `02684` | `0105` |
| `regime_especial_tributacao` | não envia | `"6"` |
| `aliquota` | não envia (Focus calcula) | `0.02` |

`src/billing/nfse-payload.ts` corrigido pra bater exatamente com essa config.

**Retestado contra `FOCUS_ENV=homologacao` com a config corrigida: mesmo erro 1002** ("Versão do Schema XML Incorreto"). Isso prova que o payload nunca foi o problema real — o `pster-finance` emite direto em produção, nunca testou homologação. **O sandbox de São Paulo dentro do Focus, especificamente pra essa inscrição municipal, tem um impasse de leiaute (pede leiaute 2 no erro 1002, recusa leiaute 2 no erro 641) independente do payload enviado** — é limitação do ambiente de teste, não do código.

**Decisão do usuário (2026-09-07): aceitar a limitação conhecida.** Payload fica como está agora (idêntico à config de produção real). Confirmação de `autorizado` de verdade fica adiada pra Fase 7, quando `FOCUS_ENV=producao` for usado. **Nenhum teste em produção foi feito antes dessa decisão, e nenhum deve ser feito sem nova aprovação explícita.** Não reabrir essa investigação — a causa raiz já está identificada e documentada aqui.
