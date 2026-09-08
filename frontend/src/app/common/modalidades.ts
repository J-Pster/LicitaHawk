/**
 * Tabela de dominio oficial "Modalidade de Contratacao" do PNCP (GET /v1/modalidades, mesma fonte
 * usada pelo backend em backend/src/common/modalidades.ts -- mantenha as duas listas em
 * sincronia se o PNCP mudar). O matcher de webhook (backend) faz igualdade EXATA de string contra
 * o nome real do PNCP -- por isso um <select> em vez de texto livre em qualquer formulario que
 * crie um filtro/webhook (busca de licitacoes continua texto livre de proposito, ver
 * backend/src/common/query-validation.ts).
 */
export const MODALIDADES: readonly string[] = [
  'Leilão - Eletrônico',
  'Diálogo Competitivo',
  'Concurso',
  'Concorrência - Eletrônica',
  'Concorrência - Presencial',
  'Pregão - Eletrônico',
  'Pregão - Presencial',
  'Dispensa',
  'Inexigibilidade',
  'Manifestação de Interesse',
  'Pré-qualificação',
  'Credenciamento',
  'Leilão - Presencial',
  'Inaplicabilidade da Licitação',
  'Chamada pública',
];
