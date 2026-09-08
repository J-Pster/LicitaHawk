import { TenderListItem } from "../tenders/tender.types";

/**
 * Remove acento (NFD + strip diacritico via a faixa Unicode de combining marks) e caixa. Mesma
 * normalizacao usada em keywords_tokenized (ver pncp-client.ts). Extraido pra corrigir
 * inconsistencia real: antes, o match contra tender.objeto nao normalizava acento (match
 * contra keywords_tokenized normalizava, contra objeto bruto nao), entao a mesma busca podia
 * achar por um caminho e nao achar pelo outro.
 *
 * Exportada porque os filtros de `municipio` e `situacao` (tenders.service.ts) precisam da MESMA
 * regra: quem digita "goiania" tem que achar "Goiânia", igual acontece com a keyword.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Usado tanto pela busca da API (tenders.service.ts) quanto pelo matcher de webhook (Fase 4). */
export function matchesKeyword(tender: TenderListItem, keyword: string | undefined): boolean {
  const needle = keyword?.trim();
  if (!needle) return true;
  const normalizedNeedle = normalizeText(needle);
  if (tender.objeto && normalizeText(tender.objeto).includes(normalizedNeedle)) return true;
  return tender.keywords_tokenized?.some((token) => normalizeText(token).includes(normalizedNeedle)) ?? false;
}
