import { SavedFilter } from "../webhook/filter.types";

export type PublicFilter = Omit<SavedFilter, "webhook_secret">;

// webhook_secret nunca sai da API depois de gerado (CSPRNG, so existe pro dispatcher da Fase 4
// assinar o payload) -- toda resposta (REST e MCP) usa esta funcao pra remover o campo antes de
// responder. Extraido na integracao final (estava duplicado em filters.router.ts e mcp.router.ts).
// Filtro de email nao tem o campo pra comecar; o destructuring cobre os dois canais sem ramo.
export function toPublicFilter(filter: SavedFilter): PublicFilter {
  const { webhook_secret: _webhookSecret, ...publicFilter } = filter as SavedFilter & {
    webhook_secret?: string;
  };
  return publicFilter as PublicFilter;
}
