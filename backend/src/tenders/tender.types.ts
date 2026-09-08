export interface Tender {
  pncp_control_number: string;
  org_cnpj: string;
  org_name: string;
  uf: string;
  municipio: string;
  modalidade: string;
  /**
   * Chave composta derivada (`${uf}#${modalidade}`, ver tender-query.ts::ufModalidadeKey). Nao vem
   * do PNCP: e' escrita na normalizacao (pncp-client.ts) so pra existir uma partition key que
   * responda "esta modalidade DENTRO desta UF" numa unica Query (GSI4). Nunca sai na API -- por
   * isso `TenderListItem` a remove.
   */
  uf_modalidade: string;
  objeto: string;
  valor_estimado: number;
  data_publicacao: string;
  data_atualizacao: string;
  situacao: string;
  link_pncp: string;
  keywords_tokenized: string[];
  raw_payload: unknown;
}

/**
 * O que as rotas de LISTA devolvem: o item sem `raw_payload` (dezenas de KB de payload cru do PNCP
 * por licitacao, que so o endpoint de detalhe precisa) e sem a chave de indice derivada
 * `uf_modalidade`. E' exatamente o conjunto projetado nas Queries de busca (tender-query.ts), entao
 * o tipo descreve o que existe de verdade em memoria -- nao um Tender completo fingindo estar la.
 */
export type TenderListItem = Omit<Tender, "raw_payload" | "uf_modalidade">;
