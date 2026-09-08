import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../config';

export interface AccountInfo {
  customer_id: string;
  email: string;
  plan_tier: 'free' | 'starter' | 'pro';
  created_at: string;
  has_api_key: boolean;
  api_key?: string;
}

export interface AccountUsage {
  plan: string;
  requestsThisMonth: number;
  monthlyLimit: number;
  monthlyRemaining: number;
  perMinuteLimit: number;
}

export interface CheckoutResult {
  plan: 'starter' | 'pro';
  checkout_url: string;
  pix_qr_code?: {
    encoded_image: string;
    payload: string;
    expiration_date?: string;
  };
  asaas_subscription_id: string;
}

export interface SubscriptionStatus {
  plan_tier: 'free' | 'starter' | 'pro';
  pending_plan_tier: 'starter' | 'pro' | null;
  checkout_url: string | null;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  created_at: string;
  expires_at: string | null;
  active: boolean;
}

export interface CreateApiKeyResult extends ApiKeySummary {
  api_key: string;
}

export interface UpdateApiKeyInput {
  name?: string;
  expires_at?: string | null;
}

export interface AccountWebhook {
  id: string;
  name: string | null;
  uf: string;
  modalidade: string;
  keyword: string | null;
  webhook_url: string;
  active: boolean;
  consecutive_failures: number;
  created_at: string;
}

export interface CreateWebhookInput {
  uf: string;
  modalidade: string;
  webhook_url: string;
  keyword?: string;
  name?: string;
}

export interface UpdateWebhookInput {
  name?: string | null;
  webhook_url?: string;
}

/**
 * Alerta por email: mesmo critério de disparo de um webhook, entregue no email da conta em vez de
 * num endpoint. Por isso não tem `webhook_url` -- o destinatário nunca é escolhido pelo cliente,
 * é sempre o email da conta, resolvido pelo backend na hora do envio.
 */
export interface AccountAlert {
  id: string;
  name: string | null;
  uf: string;
  modalidade: string;
  keyword: string | null;
  channel: 'email';
  active: boolean;
  consecutive_failures: number;
  created_at: string;
}

export interface CreateAlertInput {
  uf: string;
  modalidade: string;
  keyword?: string;
  name?: string;
}

export interface CopyAlertToWebhookInput {
  webhook_url: string;
  name?: string;
}

export interface DailyUsageDay {
  date: string;
  api_count: number;
  mcp_count: number;
  ui_count: number;
  webhook_count: number;
  email_count: number;
  total_count: number;
}

export interface DailyUsageTotals {
  api: number;
  mcp: number;
  ui: number;
  webhook: number;
  email: number;
}

export interface DailyUsageResponse {
  days: DailyUsageDay[];
  totals: DailyUsageTotals;
}

export interface WebhookDelivery {
  filter_id: string;
  timestamp: string;
  success: boolean;
  status_code: number | null;
  error: string | null;
  attempts: number;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpInfo {
  mcp_url: string;
  tools: McpToolInfo[];
}

/**
 * Shape observado em dados reais do PNCP (raw_payload, investigado via scan direto no DynamoDB
 * Local em 2026-09-07 -- não é a OpenAPI oficial, é o payload cru de fato gravado). O backend
 * (tender.types.ts) tipa como `unknown` de propósito (Risco #2 do PLAN.md: schema do PNCP pode
 * mudar sem aviso, ver pncp-client.ts::normalizeTender) -- por isso o índice de assinatura no
 * final, pra não quebrar se o PNCP adicionar/remover campos. Não inclui itens/anexos do edital:
 * esse payload vem só do endpoint de listagem (/contratacoes/atualizacao), não do endpoint de
 * detalhe com itens -- a ingestão atual nunca chama esse segundo endpoint.
 */
export interface TenderRawPayload {
  numeroControlePNCP?: string;
  numeroCompra?: string;
  processo?: string;
  anoCompra?: number;
  sequencialCompra?: number;
  objetoCompra?: string;
  informacaoComplementar?: string;
  valorTotalEstimado?: number;
  valorTotalHomologado?: number | null;
  dataInclusao?: string;
  dataAtualizacao?: string;
  dataPublicacaoPncp?: string;
  /** Prazo de abertura das propostas -- útil pra exibir "abre em"/"encerra em" na tela de detalhe. */
  dataAberturaProposta?: string;
  /** Prazo de encerramento das propostas. */
  dataEncerramentoProposta?: string;
  situacaoCompraId?: number;
  situacaoCompraNome?: string;
  modalidadeId?: number;
  modalidadeNome?: string;
  modoDisputaId?: number;
  modoDisputaNome?: string;
  tipoInstrumentoConvocatorioCodigo?: number;
  tipoInstrumentoConvocatorioNome?: string;
  amparoLegal?: {
    codigo?: number;
    nome?: string;
    descricao?: string;
  };
  orgaoEntidade?: {
    cnpj?: string;
    razaoSocial?: string;
    poderId?: string;
    esferaId?: string;
  };
  unidadeOrgao?: {
    codigoUnidade?: string;
    nomeUnidade?: string;
    codigoIbge?: string;
    municipioNome?: string;
    ufNome?: string;
    ufSigla?: string;
  };
  orgaoSubRogado?: unknown;
  unidadeSubRogada?: unknown;
  emendaParlamentar?: unknown;
  usuarioNome?: string;
  linkSistemaOrigem?: string;
  linkProcessoEletronico?: string | null;
  [key: string]: unknown;
}

export interface Tender {
  pncp_control_number: string;
  org_cnpj: string;
  org_name: string;
  uf: string;
  municipio: string;
  modalidade: string;
  objeto: string;
  valor_estimado: number;
  data_publicacao: string;
  data_atualizacao: string;
  situacao: string;
  link_pncp: string;
  keywords_tokenized?: string[];
  raw_payload?: TenderRawPayload;
}

/**
 * Detalhe completo de uma licitacao, buscado no PNCP sob demanda pelo backend e persistido la
 * (ver backend/src/tenders/tender-detail.service.ts). E o mesmo conjunto de dados que a pagina do
 * governo mostra: dados da compra, itens, resultado por item, documentos e historico.
 */
export interface TenderItemResult {
  fornecedor_nome: string;
  fornecedor_ni: string;
  fornecedor_porte: string;
  fornecedor_natureza_juridica: string | null;
  valor_unitario_homologado: number | null;
  valor_total_homologado: number | null;
  quantidade_homologada: number | null;
  percentual_desconto: number | null;
  data_resultado: string | null;
  situacao: string | null;
  ordem_classificacao: number | null;
}

export interface TenderItem {
  numero: number;
  descricao: string;
  quantidade: number;
  unidade_medida: string;
  valor_unitario_estimado: number;
  valor_total: number;
  material_ou_servico: string;
  criterio_julgamento: string;
  situacao: string;
  tem_resultado: boolean;
  tipo_beneficio: string;
  ncm_nbs_codigo: string | null;
  informacao_complementar: string | null;
  resultados: TenderItemResult[];
}

export interface TenderDocument {
  sequencial: number;
  titulo: string;
  tipo: string;
  data_publicacao: string;
  ativo: boolean;
  url: string;
}

export interface TenderHistoryEntry {
  data: string;
  tipo: string;
  categoria: string;
  usuario: string | null;
  documento_titulo: string | null;
  justificativa: string | null;
}

export interface TenderDetail {
  pncp_control_number: string;
  fetched_at: string;
  source_updated_at: string;
  compra: TenderRawPayload & Record<string, unknown>;
  itens: TenderItem[];
  itens_total: number;
  itens_truncados: boolean;
  resultados_truncados: boolean;
  documentos: TenderDocument[];
  historico: TenderHistoryEntry[];
  historico_truncado: boolean;
  /** Secoes que o PNCP nao entregou na ultima busca. Vazio = detalhe completo. */
  secoes_indisponiveis: string[];
}

export interface FullTender extends Tender {
  detail: TenderDetail | null;
  /** Preenchido quando o PNCP falhou: a tela mostra o que ja tinha e oferece tentar de novo. */
  detail_error: string | null;
  /** True quando o detalhe ainda precisa ser buscado no PNCP (resposta pediu so o cache). */
  detail_pending: boolean;
}

/**
 * Retrato dos campos de exibição da licitação no momento em que foi salva (backend:
 * account/saved-tender.types.ts). Existe pra a lista de "Licitações salvas" renderizar sem
 * buscar cada licitação de novo -- pode divergir um pouco do estado atual até a próxima vez
 * que a licitação for salva de novo.
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
  data_encerramento_proposta: string | null;
}

export interface SavedTender {
  account_id: string;
  pncp_control_number: string;
  note: string | null;
  created_at: string;
  snapshot: SavedTenderSnapshot;
}


export interface TenderSearchParams {
  uf?: string[];
  modalidade?: string[];
  keyword?: string;
  municipio?: string;
  situacao?: string[];
  valorMin?: number;
  valorMax?: number;
  dataInicial?: string;
  dataFinal?: string;
  sort?: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
}

export interface TenderSearchResult {
  data: Tender[];
  next_cursor?: string;
  /** Existe (ou pode existir) mais resultado além desta página. */
  has_more: boolean;
  /**
   * A página veio com menos de `limit` itens porque o backend atingiu o teto de leitura por
   * requisição, não porque os dados acabaram. Continue com `next_cursor` -- é o único caso em que
   * uma página curta ainda tem continuação.
   */
  partial: boolean;
}

/** Mesmos filtros de TenderSearchParams, exceto uf/modalidade (fixados pelo :cnpj da rota). */
export type OrgTendersParams = Omit<TenderSearchParams, 'uf' | 'modalidade'>;

/** Espelha SavedSearchCriteria do backend (backend/src/account/saved-search.types.ts) -- mesma
 * convenção de nomes de campo já usada em TenderSearchParams acima (camelCase). */
export interface SavedSearchCriteria {
  uf?: string[];
  modalidade?: string[];
  keyword?: string;
  municipio?: string;
  situacao?: string[];
  valorMin?: number;
  valorMax?: number;
  dataInicial?: string;
  dataFinal?: string;
  sort?: 'asc' | 'desc';
}

export interface SavedSearch {
  saved_search_id: string;
  account_id: string;
  name: string;
  criteria: SavedSearchCriteria;
  created_at: string;
  last_seen_at: string | null;
}

export interface UpdateSavedSearchInput {
  name?: string;
  criteria?: SavedSearchCriteria;
}

interface ApiEnvelope<T> {
  data: T;
}

/** Cadência de atualização do badge "N novas" -- igual a alerts-panel usa pra deliveries. */
const SAVED_SEARCH_COUNT_POLL_INTERVAL_MS = 90_000;

@Injectable({ providedIn: 'root' })
export class AccountService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${APP_CONFIG.apiUrl}/v1/account`;

  /** Holds the plaintext API key from the most recent provision()/createApiKey() call, if any. Shown once on the dashboard. */
  readonly justProvisionedApiKey = signal<string | null>(null);

  /** Critério de um saved search que o usuário escolheu "aplicar na busca" -- consumido por outro
   * componente (tela de busca) numa rodada seguinte; aqui só expõe o signal e o setter. */
  readonly pendingSearchCriteria = signal<SavedSearchCriteria | null>(null);

  applySavedCriteria(criteria: SavedSearchCriteria): void {
    this.pendingSearchCriteria.set(criteria);
  }

  // --- Estado central de Saved Searches -------------------------------------------------------
  // Único lugar de verdade da lista + contagens "novas" -- qualquer componente (painel duplicado
  // em mais de uma aba do dashboard, por exemplo) lê daqui, nunca mantém cópia própria, senão
  // editar/excluir num lugar não reflete no outro e cada instância faria seu próprio polling.

  readonly savedSearches = signal<SavedSearch[]>([]);
  readonly savedSearchesLoading = signal(false);
  readonly savedSearchNewCounts = signal<Record<string, number>>({});

  private savedSearchesFetchInFlight: Promise<void> | null = null;
  private savedSearchCountPollHandle: ReturnType<typeof setInterval> | null = null;

  /** Recarrega a lista central. Chamadas concorrentes (ex.: duas instâncias do painel montadas ao
   * mesmo tempo) reaproveitam a mesma requisição em vôo em vez de duplicar tráfego. */
  async refreshSavedSearches(): Promise<void> {
    if (this.savedSearchesFetchInFlight) {
      return this.savedSearchesFetchInFlight;
    }
    this.savedSearchesLoading.set(true);
    this.savedSearchesFetchInFlight = (async () => {
      try {
        const list = await this.listSavedSearches();
        this.savedSearches.set(list);
        this.ensureSavedSearchCountPolling();
        await this.refreshSavedSearchCounts();
      } finally {
        this.savedSearchesLoading.set(false);
        this.savedSearchesFetchInFlight = null;
      }
    })();
    return this.savedSearchesFetchInFlight;
  }

  /** Chamado no logout: AccountService é singleton (providedIn: 'root') e sobrevive à troca de
   * sessão -- sem isso, o polling de 90s e o estado de saved searches da conta anterior seguiriam
   * vivos/visíveis após o login de outra conta na mesma aba. */
  resetSavedSearchesState(): void {
    if (this.savedSearchCountPollHandle) {
      clearInterval(this.savedSearchCountPollHandle);
      this.savedSearchCountPollHandle = null;
    }
    this.savedSearchesFetchInFlight = null;
    this.savedSearchesLoading.set(false);
    this.savedSearches.set([]);
    this.savedSearchNewCounts.set({});
  }

  private ensureSavedSearchCountPolling(): void {
    if (this.savedSearchCountPollHandle) {
      return;
    }
    this.savedSearchCountPollHandle = setInterval(
      () => void this.refreshSavedSearchCounts(),
      SAVED_SEARCH_COUNT_POLL_INTERVAL_MS,
    );
  }

  /** Falha de rede numa contagem individual é silenciosa -- não pode derrubar as demais. Reconstrói
   * o mapa a cada rodada (em vez de só mesclar) pra não deixar contagem de item já excluído presa. */
  private async refreshSavedSearchCounts(): Promise<void> {
    const current = this.savedSearches();
    const previous = this.savedSearchNewCounts();
    const entries = await Promise.all(
      current.map(async (item): Promise<[string, number]> => {
        try {
          const newCount = await this.getSavedSearchNewCount(item.saved_search_id);
          return [item.saved_search_id, newCount];
        } catch {
          return [item.saved_search_id, previous[item.saved_search_id] ?? 0];
        }
      }),
    );
    this.savedSearchNewCounts.set(Object.fromEntries(entries));
  }

  async provision(): Promise<AccountInfo> {
    const res = await firstValueFrom(
      this.http.post<ApiEnvelope<AccountInfo>>(`${this.baseUrl}/provision`, {}),
    );
    if (res.data.api_key) {
      this.justProvisionedApiKey.set(res.data.api_key);
    }
    return res.data;
  }

  async getMe(): Promise<AccountInfo> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<AccountInfo>>(`${this.baseUrl}/me`),
    );
    return res.data;
  }

  async getUsage(): Promise<AccountUsage> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<AccountUsage>>(`${this.baseUrl}/usage`),
    );
    return res.data;
  }

  async getDailyUsage(): Promise<DailyUsageResponse> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<DailyUsageResponse>>(`${this.baseUrl}/usage/daily`),
    );
    return res.data;
  }

  async checkout(
    plan: 'starter' | 'pro',
    cpfCnpj: string,
    name: string,
  ): Promise<CheckoutResult> {
    const res = await firstValueFrom(
      this.http.post<ApiEnvelope<CheckoutResult>>(`${this.baseUrl}/checkout`, {
        plan,
        cpfCnpj,
        name,
      }),
    );
    return res.data;
  }

  async getSubscription(): Promise<SubscriptionStatus> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<SubscriptionStatus>>(`${this.baseUrl}/subscription`),
    );
    return res.data;
  }

  // --- API keys ---

  async listApiKeys(): Promise<ApiKeySummary[]> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<ApiKeySummary[]>>(`${this.baseUrl}/api-keys`),
    );
    return res.data;
  }

  async createApiKey(name: string, expiresAt: string | null): Promise<CreateApiKeyResult> {
    const res = await firstValueFrom(
      this.http.post<ApiEnvelope<CreateApiKeyResult>>(`${this.baseUrl}/api-keys`, {
        name,
        expires_at: expiresAt,
      }),
    );
    this.justProvisionedApiKey.set(res.data.api_key);
    return res.data;
  }

  async updateApiKey(id: string, fields: UpdateApiKeyInput): Promise<ApiKeySummary> {
    const res = await firstValueFrom(
      this.http.patch<ApiEnvelope<ApiKeySummary>>(`${this.baseUrl}/api-keys/${id}`, fields),
    );
    return res.data;
  }

  async revokeApiKey(id: string): Promise<void> {
    await firstValueFrom(
      this.http.post<ApiEnvelope<{ id: string; active: boolean }>>(
        `${this.baseUrl}/api-keys/${id}/revoke`,
        {},
      ),
    );
  }

  // --- Webhooks (filtros salvos, via conta) ---

  async listWebhooks(): Promise<AccountWebhook[]> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<AccountWebhook[]>>(`${this.baseUrl}/webhooks`),
    );
    return res.data;
  }

  async createWebhook(input: CreateWebhookInput): Promise<AccountWebhook> {
    const res = await firstValueFrom(
      this.http.post<ApiEnvelope<AccountWebhook>>(`${this.baseUrl}/webhooks`, input),
    );
    return res.data;
  }

  async updateWebhook(id: string, fields: UpdateWebhookInput): Promise<AccountWebhook> {
    const res = await firstValueFrom(
      this.http.patch<ApiEnvelope<AccountWebhook>>(`${this.baseUrl}/webhooks/${id}`, fields),
    );
    return res.data;
  }

  async deleteWebhook(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.baseUrl}/webhooks/${id}`));
  }

  async testWebhook(id: string): Promise<{ status: string }> {
    const res = await firstValueFrom(
      this.http.post<{ status: string }>(`${this.baseUrl}/webhooks/${id}/test`, {}),
    );
    return res;
  }

  async reactivateWebhook(id: string): Promise<{ status: string }> {
    const res = await firstValueFrom(
      this.http.post<{ status: string }>(`${this.baseUrl}/webhooks/${id}/reactivate`, {}),
    );
    return res;
  }

  async regenerateWebhookSecret(id: string): Promise<void> {
    await firstValueFrom(
      this.http.post<ApiEnvelope<{ id: string; secret_regenerated: boolean }>>(
        `${this.baseUrl}/webhooks/${id}/regenerate-secret`,
        {},
      ),
    );
  }

  // --- Alertas por email ------------------------------------------------------------------
  // Mesma tabela e mesmo serviço dos webhooks no backend; coleção separada porque o canal de
  // entrega é outro. A UI de Alertas nunca mexe em webhooks e vice-versa.

  async listAlerts(): Promise<AccountAlert[]> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<AccountAlert[]>>(`${this.baseUrl}/alerts`),
    );
    return res.data;
  }

  async createAlert(input: CreateAlertInput): Promise<AccountAlert> {
    const res = await firstValueFrom(
      this.http.post<ApiEnvelope<AccountAlert>>(`${this.baseUrl}/alerts`, input),
    );
    return res.data;
  }

  async updateAlert(id: string, name: string | null): Promise<AccountAlert> {
    const res = await firstValueFrom(
      this.http.patch<ApiEnvelope<AccountAlert>>(`${this.baseUrl}/alerts/${id}`, { name }),
    );
    return res.data;
  }

  async deleteAlert(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.baseUrl}/alerts/${id}`));
  }

  /** Dispara um email de teste real para o endereço da conta. */
  async testAlert(id: string): Promise<{ status: string; email: string }> {
    return await firstValueFrom(
      this.http.post<{ status: string; email: string }>(`${this.baseUrl}/alerts/${id}/test`, {}),
    );
  }

  async reactivateAlert(id: string): Promise<{ status: string }> {
    return await firstValueFrom(
      this.http.post<{ status: string }>(`${this.baseUrl}/alerts/${id}/reactivate`, {}),
    );
  }

  /**
   * Cria um webhook com o MESMO critério do alerta. Os critérios vêm do alerta guardado no
   * backend, não daqui -- a tela só informa a URL de destino.
   */
  async copyAlertToWebhook(id: string, input: CopyAlertToWebhookInput): Promise<AccountWebhook> {
    const res = await firstValueFrom(
      this.http.post<ApiEnvelope<AccountWebhook>>(`${this.baseUrl}/alerts/${id}/copy-to-webhook`, input),
    );
    return res.data;
  }

  async getAlertDeliveries(id: string): Promise<WebhookDelivery[]> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<WebhookDelivery[]>>(`${this.baseUrl}/alerts/${id}/deliveries`),
    );
    return res.data;
  }

  /** Feed real de entregas do webhook (sucesso/falha, tentativas) -- não é simulação. */
  async getWebhookDeliveries(id: string): Promise<WebhookDelivery[]> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<WebhookDelivery[]>>(`${this.baseUrl}/webhooks/${id}/deliveries`),
    );
    return res.data;
  }

  // --- MCP ---

  async getMcpInfo(): Promise<McpInfo> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<McpInfo>>(`${this.baseUrl}/mcp-info`),
    );
    return res.data;
  }

  // --- Busca de licitações (a API real do cliente, usada pelo Dashboard em vez de curl) ---

  async searchTenders(params: TenderSearchParams): Promise<TenderSearchResult> {
    let httpParams = new HttpParams();
    if (params.uf?.length) httpParams = httpParams.set('uf', params.uf.join(','));
    if (params.modalidade?.length) httpParams = httpParams.set('modalidade', params.modalidade.join(','));
    if (params.keyword) httpParams = httpParams.set('keyword', params.keyword);
    if (params.municipio) httpParams = httpParams.set('municipio', params.municipio);
    if (params.situacao?.length) httpParams = httpParams.set('situacao', params.situacao.join(','));
    if (params.valorMin != null) httpParams = httpParams.set('valorMin', String(params.valorMin));
    if (params.valorMax != null) httpParams = httpParams.set('valorMax', String(params.valorMax));
    if (params.dataInicial) httpParams = httpParams.set('dataInicial', params.dataInicial);
    if (params.dataFinal) httpParams = httpParams.set('dataFinal', params.dataFinal);
    if (params.sort) httpParams = httpParams.set('sort', params.sort);
    if (params.cursor) httpParams = httpParams.set('cursor', params.cursor);
    if (params.limit != null) httpParams = httpParams.set('limit', String(params.limit));

    return firstValueFrom(
      this.http.get<TenderSearchResult>(`${this.baseUrl}/playground/tenders`, { params: httpParams }),
    );
  }

  /**
   * Licitacao com tudo que o PNCP publica sobre ela.
   *
   * `refresh` forca o backend a buscar de novo no PNCP, ignorando o cache: e o que o botao
   * "Atualizar do PNCP" usa quando uma secao vem faltando (o PNCP falha de forma intermitente).
   * `cachedOnly` devolve na hora o que ja existe, marcando `detail_pending`.
   */
  async getTender(
    id: string,
    options: { refresh?: boolean; cachedOnly?: boolean } = {},
  ): Promise<FullTender> {
    const query = new URLSearchParams();
    if (options.refresh) query.set('refresh', '1');
    // `cachedOnly` responde na hora com o que ja existe, sem esperar o PNCP: e a primeira das
    // duas etapas de carregamento da tela de detalhe.
    if (options.cachedOnly) query.set('detail', 'cached');
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<FullTender>>(
        `${this.baseUrl}/playground/tenders/${encodeURIComponent(id)}${suffix}`,
      ),
    );
    return res.data;
  }

  /** Histórico de licitações de um órgão (mesma API real, via Playground -- ver
   * GET /v1/account/playground/orgaos/:cnpj/tenders). */
  async getOrgTenders(cnpj: string, params: OrgTendersParams): Promise<TenderSearchResult> {
    let httpParams = new HttpParams();
    if (params.keyword) httpParams = httpParams.set('keyword', params.keyword);
    if (params.valorMin != null) httpParams = httpParams.set('valorMin', String(params.valorMin));
    if (params.valorMax != null) httpParams = httpParams.set('valorMax', String(params.valorMax));
    if (params.dataInicial) httpParams = httpParams.set('dataInicial', params.dataInicial);
    if (params.dataFinal) httpParams = httpParams.set('dataFinal', params.dataFinal);
    if (params.sort) httpParams = httpParams.set('sort', params.sort);
    if (params.cursor) httpParams = httpParams.set('cursor', params.cursor);
    if (params.limit != null) httpParams = httpParams.set('limit', String(params.limit));

    return firstValueFrom(
      this.http.get<TenderSearchResult>(
        `${this.baseUrl}/playground/orgaos/${encodeURIComponent(cnpj)}/tenders`,
        { params: httpParams },
      ),
    );
  }

  // --- Saved Searches ---

  async listSavedSearches(): Promise<SavedSearch[]> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<SavedSearch[]>>(`${this.baseUrl}/saved-searches`),
    );
    return res.data;
  }

  async createSavedSearch(name: string, criteria: SavedSearchCriteria): Promise<SavedSearch> {
    const res = await firstValueFrom(
      this.http.post<ApiEnvelope<SavedSearch>>(`${this.baseUrl}/saved-searches`, { name, criteria }),
    );
    this.savedSearches.update((list) => [...list, res.data]);
    return res.data;
  }

  async updateSavedSearch(id: string, patch: UpdateSavedSearchInput): Promise<SavedSearch> {
    const res = await firstValueFrom(
      this.http.patch<ApiEnvelope<SavedSearch>>(`${this.baseUrl}/saved-searches/${id}`, patch),
    );
    this.savedSearches.update((list) => list.map((s) => (s.saved_search_id === id ? res.data : s)));
    return res.data;
  }

  async deleteSavedSearch(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.baseUrl}/saved-searches/${id}`));
    this.savedSearches.update((list) => list.filter((s) => s.saved_search_id !== id));
    this.savedSearchNewCounts.update(({ [id]: _removed, ...rest }) => rest);
  }

  async getSavedSearchNewCount(id: string): Promise<number> {
    const res = await firstValueFrom(
      this.http.get<{ new_count: number }>(`${this.baseUrl}/saved-searches/${id}/new-count`),
    );
    return res.new_count;
  }

  async markSavedSearchSeen(id: string): Promise<SavedSearch> {
    const res = await firstValueFrom(
      this.http.post<ApiEnvelope<SavedSearch>>(`${this.baseUrl}/saved-searches/${id}/mark-seen`, {}),
    );
    this.savedSearches.update((list) => list.map((s) => (s.saved_search_id === id ? res.data : s)));
    this.savedSearchNewCounts.update((counts) => ({ ...counts, [id]: 0 }));
    return res.data;
  }

  // --- Licitações salvas (SavedTenders: a licitação específica marcada pra acompanhar, não
  // confundir com Saved Searches acima, que são critérios de busca) ---

  async listSavedTenders(): Promise<SavedTender[]> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<SavedTender[]>>(`${this.baseUrl}/saved-tenders`),
    );
    return res.data;
  }

  async saveTender(pncpControlNumber: string, note?: string): Promise<SavedTender> {
    const res = await firstValueFrom(
      this.http.post<ApiEnvelope<SavedTender>>(`${this.baseUrl}/saved-tenders`, {
        pncp_control_number: pncpControlNumber,
        note,
      }),
    );
    return res.data;
  }

  async updateSavedTenderNote(id: string, note: string | null): Promise<SavedTender> {
    const res = await firstValueFrom(
      this.http.patch<ApiEnvelope<SavedTender>>(
        `${this.baseUrl}/saved-tenders/${encodeURIComponent(id)}`,
        { note },
      ),
    );
    return res.data;
  }

  async deleteSavedTender(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<void>(`${this.baseUrl}/saved-tenders/${encodeURIComponent(id)}`),
    );
  }

  async isTenderSaved(id: string): Promise<boolean> {
    const res = await firstValueFrom(
      this.http.get<ApiEnvelope<{ saved: boolean }>>(
        `${this.baseUrl}/saved-tenders/${encodeURIComponent(id)}/status`,
      ),
    );
    return res.data.saved;
  }
}
