/**
 * Recorte dos campos de exibicao da licitacao no momento em que foi salva. Existe porque a
 * tela de "Licitacoes salvas" lista o item sem ir buscar cada licitacao de novo na tabela
 * Tenders -- uma leitura (Query por account_id) em vez de N leituras (uma por item salvo).
 * E' um retrato, nao um espelho ao vivo: se objeto/valor/situacao mudarem no PNCP depois de
 * salva, a lista mostra o que valia no momento do save ate a proxima vez que a licitacao for
 * salva de novo (ver saveTender em saved-tenders.service.ts, que atualiza o snapshot a cada save).
 */
export interface SavedTenderSnapshot {
  objeto: string;
  org_name: string;
  uf: string;
  municipio: string;
  modalidade: string;
  valor_estimado: number;
  data_publicacao: string;
  situacao: string;
  /** Prazo de encerramento das propostas (raw_payload.dataEncerramentoProposta) -- nem toda
   *  licitacao indexada tem esse campo publicado pelo PNCP, por isso nullable. */
  data_encerramento_proposta: string | null;
}

export interface SavedTender {
  account_id: string;
  pncp_control_number: string;
  note: string | null;
  created_at: string;
  snapshot: SavedTenderSnapshot;
}
