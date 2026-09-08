import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { APP_CONFIG } from '../../config';
import { CodeBlock, CollapsibleSection, PageHeader } from '../../shared';

interface EndpointParam {
  readonly name: string;
  readonly where: 'query' | 'path' | 'body';
  readonly required: boolean;
  readonly description: string;
}

interface EndpointDoc {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly params?: readonly EndpointParam[];
  readonly exampleCurl: string;
  readonly exampleResponse: string;
}

const BASE = APP_CONFIG.apiUrl;
const AUTH_HEADER = '-H "Authorization: Bearer SUA_API_KEY"';

/** Exemplos de payload usados nas respostas de exemplo abaixo -- extraídos dos schemas Tender e
 * SavedFilter em backend/docs/openapi.yaml, não inventados. */
const EXAMPLE_TENDER = {
  pncp_control_number: '07547821000191-1-000084/2026',
  org_cnpj: '07547821000191',
  org_name: 'Prefeitura Municipal de Goiânia',
  uf: 'GO',
  municipio: 'Goiânia',
  modalidade: 'Pregão - Eletrônico',
  objeto: 'Aquisição de materiais de informática',
  valor_estimado: 128500.0,
  data_publicacao: '2026-08-12T10:00:00',
  data_atualizacao: '2026-08-14T09:30:00',
  situacao: 'Divulgada no PNCP',
  link_pncp: 'https://pncp.gov.br/app/editais/07547821000191/2026/84',
};

const EXAMPLE_FILTER = {
  customer_id: 'c_8f21a0',
  filter_id: 'f_3d9b21',
  name: 'Informática em GO',
  uf: 'GO',
  modalidade: 'Pregão - Eletrônico',
  keyword: 'software',
  webhook_url: 'https://seu-servico.com/webhook',
  active: true,
  consecutive_failures: 0,
  created_at: '2026-08-01T12:00:00.000Z',
  updated_at: '2026-08-01T12:00:00.000Z',
};

const json = (value: unknown): string => JSON.stringify(value, null, 2);

const ENDPOINTS: readonly EndpointDoc[] = [
  {
    method: 'GET',
    path: '/v1/tenders',
    summary: 'Busca licitações por UF ou modalidade',
    description:
      'Exige "uf" OU "modalidade" (a API nunca faz Scan na tabela). Os dois aceitam até 5 valores separados por vírgula numa única chamada (ex.: uf=GO,SP,MG); nesse modo a paginação por cursor não é suportada. "keyword" e a faixa de valor são aplicados sobre a página já retornada, então data.length pode vir menor que limit mesmo havendo mais resultados: use next_cursor para continuar.',
    params: [
      { name: 'uf', where: 'query', required: false, description: 'Sigla de 2 letras, ou lista separada por vírgula (máx. 5). Obrigatório se "modalidade" não for informado.' },
      { name: 'modalidade', where: 'query', required: false, description: 'Nome da modalidade (texto do PNCP), ou lista separada por vírgula (máx. 5).' },
      { name: 'keyword', where: 'query', required: false, description: 'Busca por palavra-chave no objeto da licitação.' },
      { name: 'valorMin', where: 'query', required: false, description: 'Filtra valor_estimado >= valorMin.' },
      { name: 'valorMax', where: 'query', required: false, description: 'Filtra valor_estimado <= valorMax.' },
      { name: 'dataInicial', where: 'query', required: false, description: 'ISO 8601. Precisa vir junto com dataFinal.' },
      { name: 'dataFinal', where: 'query', required: false, description: 'ISO 8601. Precisa vir junto com dataInicial.' },
      { name: 'sort', where: 'query', required: false, description: '"asc" ou "desc" (padrão) por data_publicacao.' },
      { name: 'limit', where: 'query', required: false, description: 'Padrão 20, de 1 a 100.' },
      { name: 'cursor', where: 'query', required: false, description: 'next_cursor da página anterior. Não suportado com uf/modalidade em lista.' },
    ],
    exampleCurl: `curl -s "${BASE}/v1/tenders?uf=GO&keyword=software&limit=10" \\\n  ${AUTH_HEADER}`,
    exampleResponse: json({ data: [EXAMPLE_TENDER], next_cursor: 'eyJwayI6Ii4uLiJ9' }),
  },
  {
    method: 'GET',
    path: '/v1/tenders/{id}',
    summary: 'Detalhe completo de uma licitação',
    description:
      'Devolve tudo que o PNCP publica sobre a contratação, não só o recorte indexado para busca: em `detail` vêm os dados completos da compra (`detail.compra`, payload cru do PNCP), os itens com valor unitário, o resultado de cada item quando já houve homologação (fornecedor vencedor, valor homologado e data), os documentos para download e o histórico de alterações. O detalhe é buscado no PNCP na primeira consulta e guardado; as seguintes vêm do cache, revalidado assim que a licitação muda no PNCP. O PNCP falha de forma intermitente: quando uma seção não vem, ela chega vazia e é nomeada em `detail.secoes_indisponiveis`, e o resto continua válido. id é o pncp_control_number, que sempre contém uma barra literal (ex.: "07547821000191-1-000084/2026"). URL-encode a barra (%2F) antes de montar a URL na mão, senão o servidor responde 404. Bibliotecas HTTP padrão fazem isso sozinhas.',
    params: [
      { name: 'id', where: 'path', required: true, description: 'pncp_control_number, url-encoded (barra vira %2F).' },
      { name: 'refresh', where: 'query', required: false, description: '1 para ignorar o cache e rebuscar no PNCP agora.' },
    ],
    exampleCurl: `curl -s "${BASE}/v1/tenders/07547821000191-1-000084%2F2026" \\\n  ${AUTH_HEADER}`,
    exampleResponse: json({
      data: {
        ...EXAMPLE_TENDER,
        detail: {
          fetched_at: '2026-09-08T11:20:00.000Z',
          source_updated_at: '2026-08-31T10:26:08',
          compra: {
            numeroCompra: '010.2026-SEINFRA',
            processo: '010.2026-SEINFRA',
            modoDisputaNome: 'Aberto',
            amparoLegal: { nome: 'Lei 14.133/2021, Art. 28, II', codigo: 2 },
            dataAberturaProposta: '2026-08-28T00:00:00',
            dataEncerramentoProposta: '2026-09-16T09:59:00',
            valorTotalHomologado: null,
            srp: false,
          },
          itens: [
            {
              numero: 1,
              descricao: 'Execução da obra',
              quantidade: 1,
              unidade_medida: 'SRV',
              valor_unitario_estimado: 284046.77,
              valor_total: 284046.77,
              criterio_julgamento: 'Menor preço',
              situacao: 'Em andamento',
              tem_resultado: false,
              resultados: [],
            },
          ],
          itens_total: 1,
          itens_truncados: false,
          resultados_truncados: false,
          documentos: [
            {
              sequencial: 1,
              titulo: 'Edital',
              tipo: 'Edital',
              data_publicacao: '2026-08-28T12:37:53',
              ativo: true,
              url: 'https://pncp.gov.br/api/pncp/v1/orgaos/07547821000191/compras/2026/84/arquivos/1',
            },
          ],
          historico: [
            {
              data: '2026-08-28T12:37:53',
              tipo: 'Inclusão',
              categoria: 'Contratação',
              usuario: 'Sistema de origem',
              documento_titulo: null,
              justificativa: null,
            },
          ],
          historico_truncado: false,
          secoes_indisponiveis: [],
        },
        detail_error: null,
      },
    }),
  },
  {
    method: 'GET',
    path: '/v1/orgaos/{cnpj}/tenders',
    summary: 'Licitações de um órgão',
    description: 'Lista o histórico de licitações de um órgão específico pelo CNPJ, com os mesmos filtros de faixa de valor, data e ordenação de /v1/tenders (exceto uf/modalidade, fixados pelo próprio órgão).',
    params: [
      { name: 'cnpj', where: 'path', required: true, description: 'CNPJ do órgão, sem máscara.' },
      { name: 'dataInicial', where: 'query', required: false, description: 'ISO 8601. Precisa vir junto com dataFinal.' },
      { name: 'dataFinal', where: 'query', required: false, description: 'ISO 8601. Precisa vir junto com dataInicial.' },
      { name: 'valorMin', where: 'query', required: false, description: 'Filtra valor_estimado >= valorMin.' },
      { name: 'valorMax', where: 'query', required: false, description: 'Filtra valor_estimado <= valorMax.' },
      { name: 'sort', where: 'query', required: false, description: '"asc" ou "desc" (padrão) por data_publicacao.' },
      { name: 'limit', where: 'query', required: false, description: 'Padrão 20, de 1 a 100.' },
      { name: 'cursor', where: 'query', required: false, description: 'next_cursor da página anterior.' },
    ],
    exampleCurl: `curl -s "${BASE}/v1/orgaos/07547821000191/tenders?limit=10" \\\n  ${AUTH_HEADER}`,
    exampleResponse: json({ data: [EXAMPLE_TENDER], next_cursor: 'eyJwayI6Ii4uLiJ9' }),
  },
  {
    method: 'POST',
    path: '/v1/filters',
    summary: 'Cria um filtro salvo com alerta por webhook',
    description: 'uf, modalidade e webhook_url são obrigatórios. uf é validada contra as 27 siglas; webhook_url precisa ser uma URL http(s) bem formada. Cada nova licitação que casar com o filtro dispara uma entrega assinada (HMAC-SHA256) para webhook_url.',
    params: [
      { name: 'uf', where: 'body', required: true, description: 'Sigla de 2 letras, ex.: GO.' },
      { name: 'modalidade', where: 'body', required: true, description: 'Nome da modalidade.' },
      { name: 'webhook_url', where: 'body', required: true, description: 'URL http(s) que recebe a notificação.' },
      { name: 'keyword', where: 'body', required: false, description: 'Restringe o alerta a licitações com esse termo no objeto.' },
      { name: 'name', where: 'body', required: false, description: 'Rótulo do filtro, só para identificação.' },
    ],
    exampleCurl: `curl -s -X POST "${BASE}/v1/filters" \\\n  ${AUTH_HEADER} \\\n  -H "Content-Type: application/json" \\\n  -d '{"uf":"GO","modalidade":"Pregão - Eletrônico","keyword":"software","webhook_url":"https://seu-servico.com/webhook"}'`,
    exampleResponse: json({ data: EXAMPLE_FILTER }),
  },
  {
    method: 'GET',
    path: '/v1/filters',
    summary: 'Lista os filtros salvos da conta',
    description: 'Retorna todos os filtros do customer autenticado pela API key. webhook_secret nunca aparece na resposta.',
    exampleCurl: `curl -s "${BASE}/v1/filters" \\\n  ${AUTH_HEADER}`,
    exampleResponse: json({ data: [EXAMPLE_FILTER] }),
  },
  {
    method: 'DELETE',
    path: '/v1/filters/{id}',
    summary: 'Remove um filtro salvo',
    description: 'Só o dono do filtro pode remover; pedir o filtro de outro customer responde 404 (nunca 403, para não confirmar a existência do recurso a terceiros).',
    params: [{ name: 'id', where: 'path', required: true, description: 'filter_id do filtro.' }],
    exampleCurl: `curl -s -X DELETE "${BASE}/v1/filters/f_3d9b21" \\\n  ${AUTH_HEADER}`,
    exampleResponse: '204 No Content (corpo vazio)',
  },
  {
    method: 'GET',
    path: '/v1/filters/{id}/deliveries',
    summary: 'Histórico de entregas do webhook',
    description: 'Mostra as últimas tentativas de entrega (sucesso/falha, status HTTP, tentativas) do webhook associado ao filtro.',
    params: [{ name: 'id', where: 'path', required: true, description: 'filter_id do filtro.' }],
    exampleCurl: `curl -s "${BASE}/v1/filters/f_3d9b21/deliveries" \\\n  ${AUTH_HEADER}`,
    exampleResponse: json({
      data: [
        { filter_id: 'f_3d9b21', timestamp: '2026-09-01T08:12:00.000Z', success: true, status_code: 200, error: null, attempts: 1 },
      ],
    }),
  },
  {
    method: 'POST',
    path: '/v1/filters/{id}/test',
    summary: 'Dispara um webhook de teste',
    description: 'Enfileira uma entrega de teste (payload sintético) contra a webhook_url cadastrada, pelo mesmo pipeline de assinatura HMAC/retry do disparo real. Útil para validar a URL antes de depender de um alerta de verdade.',
    params: [{ name: 'id', where: 'path', required: true, description: 'filter_id do filtro.' }],
    exampleCurl: `curl -s -X POST "${BASE}/v1/filters/f_3d9b21/test" \\\n  ${AUTH_HEADER}`,
    exampleResponse: json({ status: 'queued' }),
  },
  {
    method: 'POST',
    path: '/v1/filters/{id}/reactivate',
    summary: 'Reativa um filtro desligado pelo circuit breaker',
    description: 'Depois de 5 falhas de entrega consecutivas o filtro é desativado automaticamente. Esta rota só aceita reativar um filtro que está de fato desativado (active=false); chamar num filtro já ativo responde 409 (code FILTER_NOT_DISABLED).',
    params: [{ name: 'id', where: 'path', required: true, description: 'filter_id do filtro.' }],
    exampleCurl: `curl -s -X POST "${BASE}/v1/filters/f_3d9b21/reactivate" \\\n  ${AUTH_HEADER}`,
    exampleResponse: json({ status: 'reactivated' }),
  },
];

/**
 * Documentação prática dentro do produto: início rápido, referência dos endpoints (extraída de
 * backend/docs/openapi.yaml, não inventada) e limites de uso. Complementa o Swagger interativo do
 * backend (link abaixo) para quem quer só ler sem sair do produto.
 */
@Component({
  selector: 'app-api-docs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, CollapsibleSection, PageHeader, CodeBlock],
  templateUrl: './api-docs.html',
  styleUrl: './api-docs.scss',
})
export class ApiDocs {
  readonly endpoints = ENDPOINTS;
  readonly swaggerUrl = `${BASE}/docs`;

  readonly firstCallExample = `curl -s "${BASE}/v1/tenders?uf=GO&keyword=software" \\\n  ${AUTH_HEADER}`;

  readonly responseFormatExample = json({ data: [EXAMPLE_TENDER], next_cursor: 'eyJwayI6Ii4uLiJ9' });

  readonly errorFormatExample = json({
    error: { code: 'VALIDATION_ERROR', message: 'uf ou modalidade deve ser informado.' },
  });
}
