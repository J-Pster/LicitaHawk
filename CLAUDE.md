<!-- Bloco de orquestração do OMC deliberadamente ausente: o bloco idêntico já carrega
     de ~/.claude/CLAUDE.md em toda sessão e em todo subagente. Não re-adicione aqui. -->

**Memory-first:** antes de QUALQUER tarefa (implementação, análise, segurança, arquitetura, infra), chame `memory_query` (ai-memory MCP) com palavras-chave relevantes para checar padrões e decisões já estabelecidos. ai-memory é a fonte única de conhecimento e wiki do projeto; o que está lá tem precedência sobre proposta nova.

---

# O que é o LicitaHawk

API REST + servidor MCP sobre os dados oficiais de licitações públicas do PNCP (Brasil), com webhook de alerta e assinatura recorrente (Asaas + nota fiscal via Focus NFe). Produto novo, monorepo, MVP em construção.

**`PLAN.md` na raiz é o ledger de execução.** Se você é uma sessão nova retomando o trabalho, leia o topo dele primeiro: estado atual, o que já foi testado ao vivo, o que está pendente e as decisões de design já fechadas.

## Estrutura

| Pasta | O que é |
|-------|---------|
| `backend/` | Express 4 + TypeScript, DynamoDB (local em dev), servidor MCP, scheduler de ingestão, billing Asaas |
| `frontend/` | Angular 22 standalone (sem NgRx, sem Amplify), auth via `amazon-cognito-identity-js` |
| `legal/` | Termos de serviço e afins |
| `docs/` | Padrões de qualidade de código (ver abaixo) |
| `PLAN.md` | Ledger de execução do MVP |
| `DESIGN.md` | Design system do frontend |

Comandos de backend rodam **dentro de `backend/`** (`npm test`, `npx tsc --noEmit`, `docker compose`); comandos de frontend, dentro de `frontend/` (`npx ng build`, `npx ng serve`).

`backend/.env` tem chaves reais (Asaas de **produção**, Focus NFe, Cognito). Nunca sobrescreva: só leia ou complete.

---

# Padrões de Qualidade de Código (obrigatório a cada sessão)

@docs/design-rules-digest.md

Versões completas (leia quando uma regra precisar de nuance ou exemplo): `docs/code-correctness-culture.md` e `docs/ai-software-design-handbook.md`.

# Padrões de UI

Antes de escrever qualquer tela, componente ou CSS no `frontend/`: **@DESIGN.md**. Ele descreve o sistema como ele existe (tokens, botões, formulários, dropdowns, modais, shell, estados) e a vitrine viva fica em `/app/ui-kit`.

As três regras que mais se violam por descuido:

1. **Não construa modal, dropdown ou campo do zero.** Já existem em `frontend/src/app/shared/` e são exportados por `shared/index.ts`. Componente novo em `shared/` só quando duas telas realmente precisam do mesmo.
2. **Nenhuma cor de chrome hardcoded.** Sempre token de `styles.scss`. Exceção única: cor funcional de status.
3. **Uma ação primária dourada por tela.** O resto é `btn-outline`/`btn-secondary`.

---

# Regras absolutas

## Nunca criar branches
Trabalhe sempre na branch atual. Proibido `git checkout -b`, `git branch <nome>`, `git switch -c` ou worktree com branch nova. Única exceção: o usuário pedir explicitamente, em palavras claras.

## Commits
Só quando o usuário pedir explicitamente, mesmo com mudanças prontas. Nunca adicionar trailer de co-autoria de IA.

## Infra
- **Conta AWS deste projeto: profile `LicitaHawk`** (account `077815499824`, região `us-east-1`, SSO em `https://joaopster.awsapps.com/start`). **Nunca** use outro profile AWS aqui: cada profile é outra conta, outro produto. Todo comando leva `--profile LicitaHawk`. Se der `Token has expired`, rode `aws sso login --profile LicitaHawk` você mesmo e continue.
  - Hosted zone Route 53: `licitahawk.com.` → `Z0432805FV5S4B9AIEPM`.
- **Nunca `cdk deploy`, nunca IaC.** Infra AWS via AWS CLI puro (regra ativa desde a criação do User Pool do Cognito, exceção já autorizada e documentada no `PLAN.md`).
- Fase 7 (deploy AWS real) e Fase 8 (validação de mercado) estão **fora de escopo** salvo pedido explícito.

## Ações irreversíveis contra serviço externo
A chave do Asaas em `.env` é de **produção**. Qualquer chamada de escrita (criar customer, criar assinatura) cria dado real na conta do usuário. Não execute sem aprovação explícita; teste com o cliente mockado.

---

# Toolkit (use, não adivinhe)

**1. Contexto (antes de qualquer tarefa)**
- **ai-memory MCP (primeiro, obrigatório):** `memory_query` para buscar padrões/decisões (sempre antes de propor arquitetura); `memory_recent` no início de sessão; `memory_read_page` para abrir uma página. **Persistir:** hooks capturam prompts e tool calls automaticamente, não escreva nota de rotina à mão; para fato/decisão/regra durável ou doc de how-it-works use `memory_write_page` (deduplique com `memory_query` antes e atualize a página existente). **Língua canônica: INGLÊS.** Auto-escopa ao projeto atual, não passe `project`/`workspace`/`cwd`.
- **Filesystem MCP:** quando as ferramentas nativas não alcançam. Sempre escopado a subdiretório específico.

**2. Código**
- **Serena (obrigatório):** Read/Edit **proibidos** em `.ts`/`.js` — use `find_symbol`, `replace_symbol_body`, `get_symbols_overview`, `find_referencing_symbols`, `get_diagnostics_for_file`, `rename_symbol`, `safe_delete_symbol`, `insert_before/after_symbol`.

**3. Pesquisa externa**
- **Context7:** `resolve-library-id` → `query-docs` antes de implementar com qualquer SDK/framework. Training data envelhece.
- **Exa:** `web_search_exa` / `web_fetch_exa` para busca geral, preferido sobre WebSearch/WebFetch nativos.

---

# Paths e `@`-mentions são pistas, não fronteiras

Quando o usuário marca um arquivo (`@frontend/src/app/pages/dashboard/`) ou cita um caminho, trate como **ponto de partida para localizar o problema**, não como o lugar onde o conserto obrigatoriamente acontece.

- A causa raiz pode estar em qualquer camada: frontend, backend, scheduler, config.
- Exemplo: "o alerta de webhook não chega" + `@frontend/...` não significa que o bug é de frontend. Pode ser o matcher de modalidade no backend, a fila de entrega ou o filtro salvo.
- Rastreie até a causa real seguindo o fluxo de dados, em vez de assumir que o conserto é no path marcado.

---

# Invariantes do projeto

- **Subagentes rodam em `sonnet`, sempre.** Passe `model: "sonnet"` explicitamente em toda chamada de `Agent`/`Task`. Sem escalação para `opus`, sem rebaixamento para `haiku`. Única exceção: pedido explícito do usuário, válido só para aquele pedido.
- **Validação no boundary, uma vez.** Zod no router, tipo forte para dentro. DynamoDB não valida nada por você (ver a house rule em `docs/design-rules-digest.md`).
- **Erro em formato único:** `{ error: { code, message } }` em toda rota da API.
- **Rate limit é do produto, não do PNCP:** teto mensal por plano + limite por minuto, ambos no backend.
- **Modalidade casa por igualdade exata de string** contra o nome oficial do PNCP. Por isso `<select>` com a tabela de domínio, nunca texto livre, em qualquer formulário que alimente filtro.
- **Frontend e backend têm cópias da tabela de modalidades** (`frontend/src/app/common/modalidades.ts` e `backend/src/common/modalidades.ts`). Se o PNCP mudar, atualize as duas.
