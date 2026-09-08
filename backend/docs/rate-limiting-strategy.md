# Estratégia de rate limiting do PNCP — ingestão paralela por múltiplas origens

> Documento de design técnico apenas. **Nenhuma infraestrutura AWS real é criada por este
> documento** — a Fase 7 (deploy AWS) continua bloqueada e nada aqui a antecipa. Este é um esboço
> para quando a Fase 7 acontecer, não uma implementação.

## Contexto

A API do PNCP (`pncp.gov.br/api/consulta`) não documenta rate limiting em lugar nenhum — nem
quando dispara, nem qual o limite, nem se é por IP, por rota, por janela de tempo, ou uma
combinação. O que se sabe hoje (ver PLAN.md, Notas de Execução #1) é só o comportamento observado
empiricamente: depois de várias rodadas de teste no mesmo dia, a API passou a devolver `429`
persistente por ~20-30min, normalizando sozinha depois.

O job de ingestão atual roda **sequencialmente**: 15 modalidades, 1 requisição/segundo, backoff
exponencial de 5 tentativas por página. Isso já é resiliente (não perde dado, não derruba o
processo), mas é **lento** — na pior hipótese (rate limit persistente), uma janela de ingestão pode
levar dezenas de minutos só em backoff. Paralelizar ingestão a partir de múltiplas origens de rede
diferentes é a forma óbvia de acelerar sem assumir que aumentar a frequência de request pela mesma
origem vai funcionar (evidência atual sugere o contrário).

Esta rodada implementou o rastreamento empírico (`src/tenders/rate-limit-tracking.ts`) que este
documento assume como pré-requisito: **não faz sentido paralelizar antes de ter dado real sobre
quando/como o rate limit dispara** — do contrário, o paralelismo pode só fazer múltiplas origens
baterem no mesmo limite ao mesmo tempo, sem ganho nenhum (ou pior, banindo mais origens de uma vez).

## Pergunta central: o rate limit é por IP?

Não sabemos ainda — é a primeira coisa que os dados de rastreamento (item 1/2 desta rodada) vão
responder com confiança, não uma suposição de design. Hipóteses e como o rastreamento atual ajuda a
testá-las:

1. **Rate limit por IP de origem**: se for isso, múltiplas origens com IPs diferentes resolvem
   completamente. É a hipótese mais provável (comportamento típico de API pública sem auth
   obrigatória) e a que este design assume como cenário principal.
2. **Rate limit por padrão de tráfego agregado** (ex.: CDN/WAF na frente do PNCP limitando por
   rota/volume total, não por IP individual): paralelizar por origem não ajudaria sozinho; ajudaria
   mais espalhar no tempo (jitter, menos requests/segundo agregados).
3. **Rate limit por combinação de headers/user-agent**: pouco provável, mas testável variando
   `User-Agent` entre origens e comparando taxa de 429 nos dados coletados.

**Critério de decisão**: só ativar paralelismo real em produção depois de ter pelo menos 1-2
semanas de dado do `RateLimitMetrics` (ver item 2 desta rodada) mostrando um padrão consistente —
por exemplo, se `avgIntervalBetween429Ms` e a distribuição por `byHourToday` mostrarem que o rate
limit está claramente correlacionado com volume de request da nossa própria origem (sugerindo IP),
paralelizar por origem tem alta chance de funcionar. Se os 429 acontecerem em horários
aparentemente aleatórios/baixo volume, pode ser instabilidade do PNCP em si (não rate limit de
verdade), e paralelizar não ajudaria — o dado evita queimar esforço de infra numa hipótese errada.

## Particionamento do trabalho entre workers

Duas dimensões de particionamento possíveis, não mutuamente exclusivas:

### Por modalidade (recomendado como partição primária)

O job já é naturalmente particionado por modalidade — o loop em `ingestWindow`
(`src/tenders/ingestion.service.ts`) processa as 15 modalidades (`MODALIDADE_CODES`) uma de cada
vez, com try/catch isolado por modalidade (uma modalidade instável não derruba as outras). Isso já
é a fronteira de paralelismo natural: cada worker/Lambda ficaria responsável por um subconjunto de
modalidades (ex.: 3-5 Lambdas, cada uma com 3-5 modalidades).

Vantagens:
- Zero mudança de schema ou lógica de negócio — só troca "for loop sequencial" por "N invocações
  paralelas, cada uma com um subset de `MODALIDADE_CODES`".
- Falha isolada por natureza (já é hoje, só em processo único).
- `RateLimitMetrics` já quebra por `modalidade#{n}#daily#{data}` (item 2 desta rodada) — dá pra
  medir se cada worker/origem está batendo rate limit de forma independente ou não.

Desvantagem: só 15 modalidades, então o paralelismo máximo útil é 15 workers; acima disso, teria
que também particionar por outra dimensão (data).

### Por faixa de data (partição secundária, só se justificar)

O job de reconciliação semanal já usa uma janela de 30 dias fixa
(`src/tenders/reconciliation.service.ts`). Se o volume justificar mais paralelismo do que 15
modalidades permitem, cada worker poderia processar uma fatia de dias dentro da janela (ex.: worker
A processa dias 1-10, worker B dias 11-20, worker C dias 21-30), cruzado com um subconjunto de
modalidades. Como a API do PNCP não aceita janela >365 dias mas aceita janelas arbitrárias menores,
isso é possível sem mudança de contrato com o PNCP.

**Não recomendado por UF** — a query do PNCP não filtra por UF na origem
(`/v1/contratacoes/atualizacao` filtra só por data+modalidade), filtrar por UF exigiria buscar tudo
e descartar depois, desperdiçando exatamente a cota de rate limit que se está tentando economizar.

## Origem de rede diferente por worker

Três opções técnicas pra dar IP de saída diferente a cada worker, do mais simples ao mais custoso:

| Opção | Como | Custo/complexidade | Quando usar |
|---|---|---|---|
| **Lambda em subnets diferentes, cada uma com seu próprio NAT Gateway** | Uma VPC com N subnets privadas, uma por worker, cada subnet roteando pra um NAT Gateway próprio (que tem um Elastic IP fixo e distinto) | Alto — NAT Gateway cobra por hora + por GB processado, e cada um custa ~US$32/mês só de uptime, fora tráfego. Multiplicado por N workers fica caro rápido pro volume do MVP. | Só se o volume de dado realmente justificar (ver Risco #5 do PLAN.md, gatilho de ~500k itens) |
| **Lambda sem VPC, saindo direto pela rede pública da AWS** (IP dinâmico da própria infra Lambda, não fixo) | Default — Lambda fora de VPC já sai com um IP de origem da AWS, mas ele **não é garantido estável nem distinto por invocação** (pool compartilhado da região) | Zero custo extra | Bom o suficiente **se** a hipótese de rate limit-por-IP-fixo não se confirmar, ou como primeiro teste barato antes de investir em NAT Gateway dedicado |
| **Elastic IP associado a uma interface de rede (ENI) dedicada por Lambda, com NAT Gateway compartilhado mas SNAT customizado, ou instância EC2 leve como proxy de saída por worker** | Uma pequena instância EC2 (ou Lambda atrás de um NAT instance, mais barato que NAT Gateway gerenciado) por origem, cada uma com seu próprio Elastic IP | Médio — EC2 t4g.nano/t3.micro custa poucos dólares/mês, mas some managed simplicity, precisa manter/patchear | Meio-termo se NAT Gateway for caro demais mas o Lambda-sem-VPC não bastar |

**Recomendação para quando a Fase 7 chegar**: começar pela opção mais barata (Lambda sem VPC,
paralelizado só por modalidade, sem investimento em IP dedicado) e só evoluir pra NAT Gateway/EIP
dedicado por origem **se os dados do `RateLimitMetrics` depois de rodar em paralelo mostrarem que
todas as origens ainda tomam 429 juntas** (evidência de que o limite realmente é por IP e o pool
compartilhado da Lambda não basta). Não vale gastar em NAT Gateway dedicado sem essa confirmação
empírica primeiro — é exatamente o tipo de decisão que os dados de rastreamento desta rodada
existem pra informar.

## Como evitar que todas as origens batam rate limit ao mesmo tempo

Mesmo com origens de rede diferentes, se todos os workers começarem exatamente no mesmo instante
(ex.: todos disparados pelo mesmo EventBridge Schedule), correm risco de coincidir em picos de
tráfego que criem um padrão agregado reconhecível do lado do PNCP (se a hipótese #2 acima — rate
limit por padrão agregado, não por IP — for a real). Mitigações, todas simples e sem custo de
infra extra:

1. **Jitter de largada por worker**: cada worker espera um delay inicial pseudo-aleatório
   (ex.: `workerId * 2s + random(0, 1s)`) antes da primeira request, em vez de todos disparando no
   segundo exato do schedule.
2. **1 req/s continua sendo o limite por worker**, não o agregado — cada worker mantém o mesmo
   `MIN_DELAY_MS` de hoje (`src/tenders/pncp-client.ts`), então N workers em paralelo não
   significa N req/s batendo ao mesmo tempo no mesmo milissegundo.
3. **Backoff correlacionado entre workers**: se um worker toma 429, os outros deveriam saber (via
   `RateLimitMetrics` — todos os workers escrevem no mesmo `state#global` e nos buckets `hourly#*`)
   e aumentar o próprio delay preventivamente, não só reagir ao próprio 429. Isso é uma evolução
   futura de `updateGlobalState` (hoje é só leitura/escrita por processo único) — precisaria de uma
   normalização mais cuidadosa envolvendo `ConditionExpression` pra evitar race entre workers
   concorrentes escrevendo no mesmo item de estado global. Fora do escopo desta rodada (só
   rastreamento single-process), mas o dado que essa rodada grava já é a base pra decidir se vale a
   pena.

## Como o rastreamento desta rodada alimenta a decisão

Resumo do critério de ativação, concreto e verificável:

- **Não ativar paralelismo em produção até existir pelo menos 1-2 semanas de `RateLimitMetrics`
  real** (a Fase 7 é a primeira vez que o ambiente de produção roda de qualquer forma, então esse
  prazo naturalmente se sobrepõe ao início da operação real).
- Ler `GET /internal/rate-limit-metrics` (implementado nesta rodada,
  `src/tenders/rate-limit.router.ts`) periodicamente e observar:
  - `byModalidadeToday`: se uma ou duas modalidades concentram a maior parte dos 429, o
    particionamento por modalidade sozinho já reduz bastante o problema (workers de modalidades
    "quentes" isolados dos demais, sem precisar de IP diferente ainda).
  - `byHourToday` / `last24HourSeries`: se os 429 se concentram em horários específicos, uma
    mitigação mais barata que paralelismo é simplesmente não rodar ingestão pesada nesses horários
    (ex.: adiar reconciliação semanal pra fora da janela de pico).
  - `avgIntervalBetween429Ms` e `avgTimeToNormalizeMs`: se o tempo médio pra normalizar depois de
    um 429 for consistente (~20-30min, como observado uma vez), dá pra dimensionar o backoff máximo
    e decidir se vale mais a pena só esperar (mais simples, grátis) do que orquestrar múltiplas
    origens (mais caro, mais complexo).
- Só se os dados mostrarem que **mesmo isolando por modalidade e horário o rate limit ainda bloqueia
  a ingestão de forma relevante**, aí sim vale o investimento de múltiplas origens de rede
  (NAT Gateway/EIP dedicado) descrito acima.
