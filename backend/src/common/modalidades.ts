import { HttpError } from "./http-error";

/**
 * Tabela de dominio oficial "Modalidade de Contratacao" do PNCP (GET /v1/modalidades em
 * https://pncp.gov.br/api/pncp/v1/modalidades -- nao documentada em prosa na OpenAPI de consulta,
 * so via esse endpoint de dominio). Ingestao (pncp-client.ts) so cobre os codigos 1-15 (ver
 * Notas de Execucao do PLAN.md); os codigos 16-19 sao modalidades internacionais que existem no
 * dominio mas nunca aparecem em `Tender.modalidade` real, entao ficam de fora daqui de proposito
 * -- incluir eles deixaria o usuario criar um filtro que nunca poderia bater com nenhum dado.
 *
 * `Tender.modalidade` (pncp-client.ts) grava o `modalidadeNome` cru do PNCP, e o matcher de
 * webhook (`tender-matcher.adapter.ts`) faz Query por igualdade EXATA de string na GSI
 * uf+modalidade -- qualquer string que nao bata caractere por caractere com um destes nomes
 * cria um filtro que nunca vai disparar, silenciosamente, para sempre. Por isso esta lista existe:
 * uma UI de selecao (dropdown) e validacao no backend evitam esse erro, em vez de aceitar texto
 * livre como `GET /v1/tenders?modalidade=` (Fase 3, mantido texto livre de proposito la, ver
 * query-validation.ts) permite pra busca.
 */
export const MODALIDADES: ReadonlyArray<{ id: number; nome: string }> = [
  { id: 1, nome: "Leilão - Eletrônico" },
  { id: 2, nome: "Diálogo Competitivo" },
  { id: 3, nome: "Concurso" },
  { id: 4, nome: "Concorrência - Eletrônica" },
  { id: 5, nome: "Concorrência - Presencial" },
  { id: 6, nome: "Pregão - Eletrônico" },
  { id: 7, nome: "Pregão - Presencial" },
  { id: 8, nome: "Dispensa" },
  { id: 9, nome: "Inexigibilidade" },
  { id: 10, nome: "Manifestação de Interesse" },
  { id: 11, nome: "Pré-qualificação" },
  { id: 12, nome: "Credenciamento" },
  { id: 13, nome: "Leilão - Presencial" },
  { id: 14, nome: "Inaplicabilidade da Licitação" },
  { id: 15, nome: "Chamada pública" },
];

const MODALIDADE_NAMES = new Set(MODALIDADES.map((m) => m.nome));

export function isValidModalidadeNome(value: string): boolean {
  return MODALIDADE_NAMES.has(value);
}

/**
 * Versao "assert" de isValidModalidadeNome (mesmo padrao de assertValidUf em query-validation.ts)
 * -- usada por rotas que precisam de correspondencia EXATA (webhooks, GSI uf+modalidade), nao so
 * de busca textual livre. Reusada por src/account/account-playground.router.ts.
 */
export function assertValidModalidadeNome(value: string): void {
  if (!isValidModalidadeNome(value)) {
    throw new HttpError(
      400,
      `modalidade invalida: '${value}'. Valores aceitos: ${MODALIDADES.map((m) => m.nome).join(", ")}`,
      "VALIDATION_ERROR",
    );
  }
}
