import { Router } from "express";
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { authenticate } from "../common/auth/api-key.middleware";
import { clientRateLimit } from "../common/client-rate-limit";
import { asyncHandler } from "../common/async-handler";
import { HttpError } from "../common/http-error";
import { assertValidModalidadeNome } from "../common/modalidades";
import { assertValidUf, assertValidWebhookUrl, parseDateRange } from "../common/query-validation";
import { getTenderById, searchTenders } from "../tenders/tenders.service";
import { createFilter, deleteOwnedFilter, listDeliveriesForOwnedFilter, listFiltersForCustomer } from "../filters/filters.service";
import { formatSearchResult, formatTenderDetail, formatTenderStats } from "./format";
import { getMonthlyUsage } from "./usage.service";
import { PLANS } from "../billing/plans";
import { PlanTier } from "../common/auth/types";

// Router MCP (Fase 6.1, expandido na Rodada 3). Exportado standalone -- o team-lead registra em
// src/server.ts, igual aos routers de tenders/filtros/webhook/billing. Reusa os MESMOS services
// da Fase 3/Filtros (nunca duplica logica de busca/CRUD) e o MESMO middleware de autenticacao por
// API key + rate limit por minuto (Rodada 2) que toda rota REST ja usa.

export const mcpRouter = Router();

// Fonte unica das descricoes das 8 ferramentas MCP -- usada tanto pelos `registerTool()` abaixo
// (buildServer) quanto por GET /v1/account/mcp-info (src/account/account.router.ts, secao
// informativa do dashboard). Extraido nesta rodada pra nao duplicar a mesma descricao em dois
// arquivos (o texto e' a documentacao oficial de cada tool, precisa ficar identico nos dois usos).
export const MCP_TOOLS_INFO: { name: string; description: string }[] = [
  {
    name: "search_tenders",
    description:
      "Busca licitacoes (tenders) publicadas no PNCP (Portal Nacional de Contratacoes Publicas). " +
      "Informe 'uf', 'modalidade', ou OS DOIS JUNTOS (ex.: pregoes eletronicos em Goias); pelo menos um dos " +
      "dois e' obrigatorio, pra nunca varrer a base inteira. Aceita ate 5 valores em cada um, e a combinacao " +
      "dos dois nao pode passar de 12 pares (ex.: 3 UFs x 4 modalidades). Use 'keyword' pra filtrar por assunto " +
      "(ex.: 'informatica', 'merenda escolar'), 'municipio' pra cidade (ex.: 'Goiania'), 'situacao' pra estado da " +
      "contratacao (ex.: ['Divulgada']), 'dataInicial'/'dataFinal' (formato YYYY-MM-DD, sempre juntos) pra limitar " +
      "o periodo, e 'valorMin'/'valorMax' pra faixa de valor estimado em reais. A paginacao via 'cursor' funciona " +
      "em QUALQUER combinacao de filtros, e cada pagina vem cheia (o filtro de keyword nao 'esvazia' a pagina). " +
      "Exemplo: pregoes eletronicos de tecnologia em Goias e Sao Paulo em setembro/2026 acima de R$50.000 -> " +
      "{ uf: ['GO','SP'], modalidade: ['Pregão - Eletrônico'], keyword: 'tecnologia', dataInicial: '2026-09-01', dataFinal: '2026-09-30', valorMin: 50000 }.",
  },
  {
    name: "get_tender_details",
    description:
      "Retorna o detalhe completo de UMA licitacao especifica pelo 'pncp_control_number' (identificador " +
      "unico devolvido por 'search_tenders' ou 'get_tender_stats'). Use quando o usuario pedir mais detalhes " +
      "sobre um resultado especifico da busca.",
  },
  {
    name: "get_tender_stats",
    description:
      "Resumo agregado sobre licitacoes que combinam com um filtro: quantidade, valor total e medio " +
      "estimado, e quebra por modalidade. Util pra perguntas como 'quantas licitacoes de TI abriram em SP " +
      "este mes' ou 'qual o valor total de pregoes de merenda escolar em GO'. Mesmas regras de " +
      "'search_tenders' ('uf' OU 'modalidade' obrigatorio, nunca os dois). Limitacao honesta: NAO e' uma " +
      "contagem exata de toda a base -- e' um resumo sobre a amostra mais recente encontrada (ate 200 " +
      "licitacoes nos planos Starter/Pro, 50 no Free). Pra numeros mais precisos, refine com 'dataInicial'/'dataFinal'.",
  },
  {
    name: "list_my_saved_filters",
    description:
      "Lista os filtros salvos do usuario autenticado, com o alerta de webhook configurado pra cada um " +
      "(uf, modalidade, palavra-chave opcional, se esta ativo). Use antes de 'create_saved_filter' pra " +
      "evitar duplicar um filtro existente, ou antes de 'delete_saved_filter'/'get_filter_deliveries' pra " +
      "descobrir o 'filter_id' certo.",
  },
  {
    name: "create_saved_filter",
    description:
      "Cria um filtro salvo com alerta por webhook pra novas licitacoes que combinem com uf+modalidade (e " +
      "keyword opcional). Exige plano Starter ou Pro (o plano Free nao inclui alertas por webhook). Use " +
      "'list_my_saved_filters' antes pra evitar duplicar um filtro ja existente.",
  },
  {
    name: "delete_saved_filter",
    description:
      "Remove um filtro salvo (e para os alertas de webhook associados a ele) pelo 'filter_id'. Use " +
      "'list_my_saved_filters' antes pra descobrir o filter_id correto. So remove filtros do proprio usuario " +
      "autenticado -- um filter_id de outro cliente responde como 'nao encontrado'.",
  },
  {
    name: "get_filter_deliveries",
    description:
      "Mostra o historico de alertas (entregas de webhook) ja disparados por um filtro salvo, do mais " +
      "recente pro mais antigo -- util pra confirmar se o alerta esta funcionando ou ver quais licitacoes ja " +
      "foram notificadas. Use 'list_my_saved_filters' antes pra descobrir o filter_id.",
  },
  {
    name: "get_usage_stats",
    description:
      "Mostra quanto do plano atual o usuario ja consumiu neste mes (requisicoes usadas/limite mensal, " +
      "requisicoes restantes) e o limite por minuto do plano. Use quando o usuario perguntar 'quanto eu ja " +
      "usei', 'estou perto do limite', ou antes de sugerir upgrade de plano.",
  },
];

function toolDescription(name: string): string {
  const found = MCP_TOOLS_INFO.find((t) => t.name === name);
  if (!found) throw new Error(`[mcp] MCP_TOOLS_INFO sem entrada para a tool '${name}'`);
  return found.description;
}

type ToolErrorResult = { content: Array<{ type: "text"; text: string }>; isError: true };

/**
 * Achado real da Rodada 3: os handlers das ferramentas MCP faziam `(err as Error).message` direto
 * -- pra um HttpError (validacao) isso e' uma mensagem PT-BR ja amigavel, mas pra qualquer outro
 * erro (ex.: DynamoDB fora do ar) vazava a mensagem interna crua pro modelo do outro lado. Alem
 * disso, nem toda ferramenta tinha try/catch (ver `list_my_saved_filters` antes desta rodada) --
 * uma excecao nao capturada ali rejeitava a Promise do handler da rota inteira (`asyncHandler`
 * so protege o processo de cair, mas devolve 500 pra TODA a chamada JSON-RPC, nao so pra aquela
 * ferramenta). Toda ferramenta agora usa este helper.
 */
function toolError(err: unknown): ToolErrorResult {
  if (err instanceof HttpError) {
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
  console.error("[mcp] erro inesperado numa tool", err);
  return {
    content: [
      { type: "text", text: "Ocorreu um erro interno ao processar sua solicitacao. Tente novamente em instantes." },
    ],
    isError: true,
  };
}

/** Mesma normalizacao de `parseUfList` (query-validation.ts), mas sobre um array ja tipado (zod), nao uma string separada por virgula. */
function normalizeUfList(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const normalized = [...new Set(values.map((v) => v.trim().toUpperCase()).filter(Boolean))];
  normalized.forEach(assertValidUf);
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Mesmo criterio de `parseModalidadeList` (query-validation.ts): dedupe/trim + validacao contra o
 * dominio oficial do PNCP. Um modelo de linguagem e' justamente quem mais erra o nome exato da
 * modalidade ("pregao eletronico" em vez de "Pregão - Eletrônico") -- devolver a lista de valores
 * aceitos no erro faz o cliente MCP corrigir sozinho, em vez de reportar "nao achei nada".
 */
function normalizeModalidadeList(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const normalized = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  normalized.forEach(assertValidModalidadeNome);
  return normalized.length > 0 ? normalized : undefined;
}

function assertValidValorRange(valorMin: number | undefined, valorMax: number | undefined): void {
  if (valorMin !== undefined && valorMax !== undefined && valorMin > valorMax) {
    throw new HttpError(400, "'valorMin' nao pode ser maior que 'valorMax'", "VALIDATION_ERROR");
  }
}

function describeFilters(params: {
  uf?: string[];
  modalidade?: string[];
  keyword?: string;
  dataInicial?: string;
  dataFinal?: string;
  valorMin?: number;
  valorMax?: number;
}): string {
  const parts: string[] = [];
  if (params.uf?.length) parts.push(`UF ${params.uf.join(", ")}`);
  if (params.modalidade?.length) parts.push(`modalidade ${params.modalidade.join(", ")}`);
  if (params.keyword) parts.push(`palavra-chave '${params.keyword}'`);
  if (params.dataInicial && params.dataFinal) parts.push(`entre ${params.dataInicial} e ${params.dataFinal}`);
  if (params.valorMin !== undefined || params.valorMax !== undefined) {
    parts.push(`valor entre ${params.valorMin ?? 0} e ${params.valorMax !== undefined ? params.valorMax : "sem teto"}`);
  }
  return parts.length > 0 ? parts.join(", ") : "o filtro informado";
}

/**
 * Monta um McpServer novo por request, com as ferramentas fechadas (closure) sobre o
 * customer_id/plan_tier ja autenticados pelo middleware Express -- evita precisar propagar auth
 * pelo contexto interno do SDK do MCP. Stateless por request (Fase 6.2, confirmado com teste real).
 */
function buildServer(customerId: string, planTier: PlanTier): McpServer {
  const server = new McpServer({ name: "licitahawk", version: "0.1.0" });

  server.registerTool(
    "search_tenders",
    {
      description: toolDescription("search_tenders"),
      inputSchema: z.object({
        uf: z.array(z.string()).max(5).optional().describe("Lista de siglas de UF (ate 5), ex: ['GO','SP']. Pode ser combinada com 'modalidade'."),
        modalidade: z.array(z.string()).max(5).optional().describe("Lista de nomes de modalidade (ate 5), ex: ['Pregão - Eletrônico']. Pode ser combinada com 'uf'. Precisa bater exatamente com o nome oficial do PNCP."),
        keyword: z.string().optional().describe("Palavra-chave a buscar no objeto da licitacao."),
        municipio: z.string().optional().describe("Nome do municipio, ex: 'Goiania'. Ignora acento e caixa."),
        situacao: z.array(z.string()).max(5).optional().describe("Situacao da contratacao, ex: ['Divulgada']. Ignora acento e caixa, casa por trecho do nome."),
        dataInicial: z.string().optional().describe("Data inicial no formato YYYY-MM-DD. Deve vir junto com 'dataFinal'."),
        dataFinal: z.string().optional().describe("Data final no formato YYYY-MM-DD. Deve vir junto com 'dataInicial'."),
        valorMin: z.number().min(0).optional().describe("Valor estimado minimo em reais, ex: 10000."),
        valorMax: z.number().min(0).optional().describe("Valor estimado maximo em reais, ex: 500000."),
        sort: z.enum(["asc", "desc"]).optional().describe("Ordenacao por data de publicacao. 'desc' (padrao) = mais recentes primeiro."),
        limit: z.number().int().min(1).max(50).optional().describe("Quantidade maxima de resultados (1-50, padrao 20). Prefira valores baixos (5-10) numa conversa."),
        cursor: z.string().optional().describe("Cursor de paginacao retornado por uma busca anterior ('next_cursor'). Funciona com qualquer combinacao de filtros."),
      }),
    },
    async (input) => {
      try {
        const uf = normalizeUfList(input.uf);
        const modalidade = normalizeModalidadeList(input.modalidade);
        const { dataInicial, dataFinal } = parseDateRange(input.dataInicial, input.dataFinal);
        assertValidValorRange(input.valorMin, input.valorMax);

        const result = await searchTenders({
          uf,
          modalidade,
          keyword: input.keyword,
          municipio: input.municipio,
          situacao: input.situacao,
          dataInicial,
          dataFinal,
          valorMin: input.valorMin,
          valorMax: input.valorMax,
          limit: input.limit,
          cursor: input.cursor,
          sort: input.sort,
        });

        const description = describeFilters({ uf, modalidade, keyword: input.keyword, dataInicial, dataFinal, valorMin: input.valorMin, valorMax: input.valorMax });
        return { content: [{ type: "text" as const, text: formatSearchResult(result, description) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "get_tender_details",
    {
      description: toolDescription("get_tender_details"),
      inputSchema: z.object({
        pncp_control_number: z.string().describe("Identificador unico da licitacao no PNCP, ex: '12345678000199-1-000045/2026'."),
      }),
    },
    async ({ pncp_control_number }) => {
      try {
        const tender = await getTenderById(pncp_control_number);
        if (!tender) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Nenhuma licitacao encontrada com o identificador '${pncp_control_number}'. Confirme o numero ou use 'search_tenders' pra localizar a licitacao primeiro.`,
              },
            ],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: formatTenderDetail(tender) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "get_tender_stats",
    {
      description: toolDescription("get_tender_stats"),
      inputSchema: z.object({
        uf: z.array(z.string()).max(5).optional().describe("Lista de siglas de UF (ate 5)."),
        modalidade: z.array(z.string()).max(5).optional().describe("Lista de nomes de modalidade (ate 5)."),
        keyword: z.string().optional().describe("Palavra-chave a buscar no objeto da licitacao."),
        dataInicial: z.string().optional().describe("Data inicial no formato YYYY-MM-DD. Deve vir junto com 'dataFinal'."),
        dataFinal: z.string().optional().describe("Data final no formato YYYY-MM-DD. Deve vir junto com 'dataInicial'."),
        valorMin: z.number().min(0).optional(),
        valorMax: z.number().min(0).optional(),
      }),
    },
    async (input) => {
      try {
        const uf = normalizeUfList(input.uf);
        const modalidade = normalizeModalidadeList(input.modalidade);
        const { dataInicial, dataFinal } = parseDateRange(input.dataInicial, input.dataFinal);
        assertValidValorRange(input.valorMin, input.valorMax);

        // Amostra maior pra planos pagos -- mesmo criterio de "quanto mais voce paga, mais dado
        // bruto voce processa por chamada" ja usado no teto mensal (PLANS) e no rate limit por
        // minuto (client-rate-limit.ts).
        const sampleLimit = planTier === "free" ? 50 : 200;

        const result = await searchTenders({
          uf,
          modalidade,
          keyword: input.keyword,
          dataInicial,
          dataFinal,
          valorMin: input.valorMin,
          valorMax: input.valorMax,
          limit: sampleLimit,
          sort: "desc",
        });

        const description = describeFilters({ uf, modalidade, keyword: input.keyword, dataInicial, dataFinal, valorMin: input.valorMin, valorMax: input.valorMax });
        return { content: [{ type: "text" as const, text: formatTenderStats(result.data, sampleLimit, description) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "list_my_saved_filters",
    {
      description: toolDescription("list_my_saved_filters"),
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const filters = await listFiltersForCustomer(customerId);
        if (filters.length === 0) {
          return {
            content: [{ type: "text" as const, text: "Nenhum filtro salvo ainda. Use 'create_saved_filter' pra criar um alerta." }],
          };
        }
        const lines = filters.map((f, i) => {
          const status = f.active ? "ativo" : "desativado (falhas consecutivas na entrega)";
          const keywordPart = f.keyword ? `, keyword='${f.keyword}'` : "";
          const destino =
            f.channel === "webhook" ? `webhook_url=${f.webhook_url}` : "canal=email (entregue no email da conta)";
          return `${i + 1}. filter_id=${f.filter_id} -- uf=${f.uf}, modalidade=${f.modalidade}${keywordPart}, status=${status}, ${destino}`;
        });
        return { content: [{ type: "text" as const, text: [`${filters.length} filtro(s) salvo(s):`, ...lines].join("\n") }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "create_saved_filter",
    {
      description: toolDescription("create_saved_filter"),
      inputSchema: z.object({
        uf: z.string().describe("Sigla da UF, ex: 'GO'."),
        modalidade: z.string().describe("Nome da modalidade, ex: 'Pregão - Eletrônico'."),
        keyword: z.string().optional().describe("Palavra-chave opcional pra restringir o alerta ao objeto da licitacao."),
        webhook_url: z.string().describe("URL http(s) que recebera um POST a cada nova licitacao correspondente, ex: 'https://seu-servico.com/webhook'."),
      }),
    },
    async ({ uf, modalidade, keyword, webhook_url: webhookUrl }) => {
      try {
        // Mesmo enforcement de plano de filters.router.ts (achado real, Fase 11: antes disso
        // existia so ali, deixando o mesmo bypass aberto via MCP).
        const plan = PLANS[planTier];
        if (!plan.webhooksEnabled) {
          return {
            content: [{ type: "text" as const, text: `O plano ${plan.name} nao inclui alertas por webhook. Faca upgrade pra Starter ou Pro pra criar filtros com alerta.` }],
            isError: true,
          };
        }
        const existing = await listFiltersForCustomer(customerId);
        if (existing.length >= plan.maxFilters) {
          return {
            content: [
              { type: "text" as const, text: `Limite de ${plan.maxFilters} filtro(s) do plano ${plan.name} atingido. Remova um filtro existente (delete_saved_filter) ou faca upgrade de plano.` },
            ],
            isError: true,
          };
        }

        // Achado real da Rodada 3: diferente de filters.router.ts (Rodada 2), esta ferramenta
        // nunca validava o formato de 'uf'/'webhook_url' -- um valor malformado so falhava
        // silenciosamente la no primeiro disparo do dispatcher (Fase 4), exatamente o bug que a
        // Rodada 2 ja tinha corrigido do lado REST. Agora reusa os mesmos helpers.
        assertValidUf(uf);
        assertValidWebhookUrl(webhookUrl);

        const filter = await createFilter(customerId, { channel: "webhook", uf: uf.toUpperCase(), modalidade, keyword, webhook_url: webhookUrl });
        return {
          content: [
            {
              type: "text" as const,
              text: `Filtro criado com sucesso (filter_id=${filter.filter_id}). Voce recebera um alerta no seu webhook sempre que uma nova licitacao de ${uf.toUpperCase()}/${modalidade}${keyword ? ` com a palavra-chave '${keyword}'` : ""} for publicada.`,
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "delete_saved_filter",
    {
      description: toolDescription("delete_saved_filter"),
      inputSchema: z.object({
        filter_id: z.string().describe("Identificador do filtro, obtido via 'list_my_saved_filters' ou na resposta de 'create_saved_filter'."),
      }),
    },
    async ({ filter_id: filterId }) => {
      try {
        const deleted = await deleteOwnedFilter(customerId, filterId);
        if (!deleted) {
          return {
            content: [{ type: "text" as const, text: `Nenhum filtro encontrado com filter_id='${filterId}'. Use 'list_my_saved_filters' pra ver os filtros existentes.` }],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: `Filtro ${filterId} removido. Os alertas por webhook associados a ele foram interrompidos.` }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "get_filter_deliveries",
    {
      description: toolDescription("get_filter_deliveries"),
      inputSchema: z.object({
        filter_id: z.string().describe("Identificador do filtro, obtido via 'list_my_saved_filters'."),
      }),
    },
    async ({ filter_id: filterId }) => {
      try {
        const { found, deliveries } = await listDeliveriesForOwnedFilter(customerId, filterId);
        if (!found) {
          return {
            content: [{ type: "text" as const, text: `Nenhum filtro encontrado com filter_id='${filterId}'. Use 'list_my_saved_filters' pra ver os filtros existentes.` }],
            isError: true,
          };
        }
        if (deliveries.length === 0) {
          return { content: [{ type: "text" as const, text: `Nenhum alerta disparado ainda para o filtro ${filterId}.` }] };
        }
        const header = `${deliveries.length} entrega(s) de alerta registrada(s) para o filtro ${filterId} (mais recente primeiro):`;
        return { content: [{ type: "text" as const, text: `${header}\n\n${JSON.stringify(deliveries, null, 2)}` }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "get_usage_stats",
    {
      description: toolDescription("get_usage_stats"),
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const usage = await getMonthlyUsage(customerId, planTier);
        const text = [
          `Plano atual: ${usage.plan}`,
          `Uso este mes: ${usage.requestsThisMonth}/${usage.monthlyLimit} requisicoes (${usage.monthlyRemaining} restantes)`,
          `Limite por minuto: ${usage.perMinuteLimit} requisicoes/minuto`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  return server;
}

mcpRouter.post(
  "/mcp",
  authenticate,
  // Achado real da Rodada 3: toda rota REST (tenders/filtros) ja aplica `clientRateLimit`
  // (Rodada 2, protecao por minuto contra rajada de um cliente) logo apos `authenticate` -- a
  // rota `/mcp` era a unica autenticada que ficava de fora, deixando o mesmo buraco que a
  // Rodada 2 ja tinha fechado em todo o resto da API. Corrigido pra manter paridade.
  clientRateLimit,
  asyncHandler(async (req, res) => {
    const server = buildServer(req.auth!.customer_id, req.auth!.plan_tier);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // Cast local: @modelcontextprotocol/server declara req.auth como AuthInfo (fluxo OAuth do
    // proprio SDK), incompativel de tipo com o req.auth: AuthContext do nosso middleware de API
    // key (mesmo nome, dono diferente). Em runtime Request e' um IncomingMessage de verdade --
    // o conflito e' so estrutural no TS. Nao mexe no shape global de req.auth (Fase 4 depende dele).
    await transport.handleRequest(req as never, res, req.body);
  }),
);
