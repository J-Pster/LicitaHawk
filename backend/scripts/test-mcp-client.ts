import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Utilitario de dev: cliente MCP real (protocolo de verdade via HTTP, nao chamada direta de
// funcao Node) pra fumaca (smoke test) do servidor MCP local depois de integrado em server.ts.
// Uso: npx tsx scripts/test-mcp-client.ts <api_key> [base_url]

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Achado real da Rodada 8: este script imprimia "tudo funcionou" no final mesmo quando uma
 * callTool no meio retornava isError:true (aconteceu com search_tenders, que desde a Rodada 2
 * exige 'uf' como array -- o script chamava com uf:"CE", uma string). O erro aparecia no log mas
 * nao interrompia nem fazia o processo sair com codigo != 0, entao uma rodada futura rodando isso
 * em CI/script automatizado veria "OK" e confiaria numa evidencia falsa. Agora toda callTool passa
 * por este helper, que lanca se isError vier true.
 */
function assertNoToolError(label: string, result: ToolCallResult): void {
  if (result.isError) {
    const text = result.content?.[0]?.text ?? JSON.stringify(result);
    throw new Error(`callTool '${label}' retornou isError:true -- ${text}`);
  }
}

async function main() {
  const apiKey = process.argv[2];
  const baseUrl = process.argv[3] ?? "http://localhost:3000";
  if (!apiKey) {
    throw new Error("uso: npx tsx scripts/test-mcp-client.ts <api_key> [base_url]");
  }

  const client = new Client({ name: "licitahawk-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });

  console.log("=== conectando (handshake initialize) ===");
  await client.connect(transport);
  console.log("conectado com sucesso.");

  console.log("=== listTools ===");
  const tools = await client.listTools();
  console.log(JSON.stringify(tools.tools.map((t) => t.name)));

  console.log("=== callTool: search_tenders (uf=['CE']) ===");
  const searchResult = await client.callTool({ name: "search_tenders", arguments: { uf: ["CE"], limit: 2 } });
  console.log(JSON.stringify(searchResult, null, 2).slice(0, 400));
  assertNoToolError("search_tenders", searchResult);

  console.log("=== callTool: create_saved_filter ===");
  const createResult = await client.callTool({
    name: "create_saved_filter",
    arguments: { uf: "GO", modalidade: "Pregão - Eletrônico", keyword: "software", webhook_url: "https://example.com/hook" },
  });
  console.log(JSON.stringify(createResult, null, 2));
  assertNoToolError("create_saved_filter", createResult);

  console.log("=== callTool: list_my_saved_filters (deve ter 1 agora, sem webhook_secret) ===");
  const filtersResult = await client.callTool({ name: "list_my_saved_filters", arguments: {} });
  console.log(JSON.stringify(filtersResult, null, 2));
  assertNoToolError("list_my_saved_filters", filtersResult);

  await client.close();
  console.log("=== OK: handshake + listTools + 4 callTool via protocolo MCP real, tudo funcionou ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FALHOU:", err);
    process.exit(1);
  });
