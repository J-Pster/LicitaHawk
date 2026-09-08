import { TenderListItem } from "../tenders/tender.types";
import { TenderSearchResult } from "../tenders/tenders.service";

// Formatacao de resposta pra consumo por um modelo de linguagem do lado do cliente MCP (Claude/
// ChatGPT), nao pra consumo programatico (isso ja existe na API REST, Fase 3). Objetivo: texto
// legivel, sem os campos internos/pesados (`raw_payload`, `keywords_tokenized`), valor em BRL,
// `objeto` truncado quando muito longo, e o link clicavel do PNCP sempre presente.

const OBJETO_TRUNCATE_LENGTH = 280;

function formatBRL(value: number | undefined | null): string {
  if (value === undefined || value === null) return "valor nao informado";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function truncateObjeto(objeto: string): string {
  if (objeto.length <= OBJETO_TRUNCATE_LENGTH) return objeto;
  return `${objeto.slice(0, OBJETO_TRUNCATE_LENGTH).trimEnd()}...`;
}

function formatTenderLine(tender: TenderListItem, index: number): string {
  return (
    `${index}. [${tender.modalidade}] ${tender.org_name} (${tender.municipio}/${tender.uf}) -- ` +
    `${truncateObjeto(tender.objeto)} -- ${formatBRL(tender.valor_estimado)} -- ` +
    `publicado em ${tender.data_publicacao} -- ${tender.link_pncp}`
  );
}

/** Resposta de `search_tenders`: cabecalho com contagem + lista numerada legivel. */
export function formatSearchResult(result: TenderSearchResult, appliedFiltersDescription: string): string {
  if (result.data.length === 0) {
    return `Nenhuma licitacao encontrada para ${appliedFiltersDescription}. Tente ampliar o filtro (ex.: remover palavra-chave, aumentar a janela de data, ou tirar a faixa de valor).`;
  }
  const header = `${result.data.length} licitacao(oes) encontrada(s) para ${appliedFiltersDescription}:`;
  const lines = result.data.map((tender, i) => formatTenderLine(tender, i + 1));
  const footer = result.next_cursor
    ? "\n\nHa mais resultados disponiveis. Peca a proxima pagina informando o parametro 'cursor' retornado, ou refine o filtro (data/palavra-chave) para ver so o mais relevante."
    : "";
  return [header, ...lines].join("\n") + footer;
}

/** Resposta de `get_tender_details`: detalhe completo (exceto `raw_payload`), sem truncar `objeto`. */
export function formatTenderDetail(tender: TenderListItem): string {
  return [
    `Licitacao ${tender.pncp_control_number}`,
    `Orgao: ${tender.org_name} (CNPJ ${tender.org_cnpj})`,
    `Local: ${tender.municipio}/${tender.uf}`,
    `Modalidade: ${tender.modalidade}`,
    `Situacao: ${tender.situacao}`,
    `Valor estimado: ${formatBRL(tender.valor_estimado)}`,
    `Publicado em: ${tender.data_publicacao} (ultima atualizacao: ${tender.data_atualizacao})`,
    `Objeto: ${tender.objeto}`,
    `Link oficial no PNCP: ${tender.link_pncp}`,
  ].join("\n");
}

/**
 * Resumo agregado (`get_tender_stats`) sobre a amostra retornada pela busca -- NAO e' uma
 * contagem exata de toda a base (nao ha `Scan`/`Count` sobre a base inteira, seria caro e o
 * plano proibe). `sampleLimit` e' o teto pedido ao service; se a amostra bateu o teto, avisamos
 * explicitamente que pode haver mais licitacoes alem das resumidas aqui.
 */
export function formatTenderStats(tenders: TenderListItem[], sampleLimit: number, appliedFiltersDescription: string): string {
  if (tenders.length === 0) {
    return `Nenhuma licitacao encontrada para ${appliedFiltersDescription}.`;
  }

  const total = tenders.reduce((sum, t) => sum + (t.valor_estimado ?? 0), 0);
  const avg = total / tenders.length;

  const byModalidade = new Map<string, number>();
  for (const t of tenders) {
    byModalidade.set(t.modalidade, (byModalidade.get(t.modalidade) ?? 0) + 1);
  }
  const breakdown = [...byModalidade.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([modalidade, count]) => `  - ${modalidade}: ${count}`)
    .join("\n");

  const datas = tenders.map((t) => t.data_publicacao).sort();
  const sampleNote =
    tenders.length >= sampleLimit
      ? `\n\nNota: resumo baseado nas ${sampleLimit} licitacoes mais recentes que combinam com o filtro (limite de amostra do seu plano) -- pode haver mais licitacoes na base alem dessas. Refine por data ou palavra-chave para uma amostra mais precisa em vez de mais ampla.`
      : "";

  return (
    [
      `Resumo de ${tenders.length} licitacao(oes) para ${appliedFiltersDescription}:`,
      `Periodo coberto na amostra: ${datas[0]} a ${datas[datas.length - 1]}`,
      `Valor total estimado: ${formatBRL(total)}`,
      `Valor medio estimado: ${formatBRL(avg)}`,
      `Por modalidade:`,
      breakdown,
    ].join("\n") + sampleNote
  );
}
