/**
 * Chave composta sintetica que torna "esta modalidade DENTRO desta UF" uma Query de GSI (uma unica
 * partition key), em vez de duas Queries que o DynamoDB nao sabe intersectar. Gravada em
 * `Tender.uf_modalidade` na normalizacao (pncp-client.ts) e indexada por GSI4
 * (`GSI4-uf_modalidade-data_publicacao`).
 *
 * O separador e' '#' porque nenhuma sigla de UF nem nome de modalidade do dominio oficial do PNCP
 * (common/modalidades.ts) contem '#' -- entao a concatenacao e' injetiva: "GO#Pregao - Eletronico"
 * so pode ter vindo de exatamente um par (uf, modalidade).
 *
 * Mora num modulo proprio, sem nenhuma dependencia, porque e' usada nos DOIS lados: na escrita
 * (pncp-client.ts, que nao pode arrastar o cliente do DynamoDB junto) e na leitura (tender-query.ts).
 * Duplicar o formato da chave entre escrita e leitura seria a classe de bug mais silenciosa
 * possivel: o indice ficaria populado com um formato e consultado com outro.
 */
export function ufModalidadeKey(uf: string, modalidade: string): string {
  return `${uf}#${modalidade}`;
}
