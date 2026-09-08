import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  AccountService,
  SavedSearchCriteria,
  Tender,
  TenderSearchParams,
} from '../../core/account.service';
import { APP_CONFIG } from '../../config';
import { CsvColumn, downloadCsv, toCsv } from '../../common/csv-export.util';
import { extractErrorMessage } from '../../core/http-error.util';
import { MODALIDADES } from '../../common/modalidades';
import { UFS } from '../../common/ufs';
import { ToastService } from '../../core/toast.service';
import {
  CodeBlock,
  EmptyState,
  HelpTooltip,
  ModalShell,
  MultiSelect,
  type MultiSelectOption,
  PageHeader,
  SelectField,
  type SelectFieldOption,
  Skeleton,
  TextField,
} from '../../shared';

const PAGE_SIZE = 20;
/** Espelha MAX_QUERY_TARGETS do backend (query-validation.ts): uf x modalidade vira uma consulta de
 * índice por par, então a combinação tem teto. Checado aqui só pra avisar antes do 400. */
const MAX_QUERY_PAIRS = 12;
/** Não há tabela de domínio publicada para `situacaoCompraNome`; o backend casa por trecho,
 * ignorando acento e caixa, então rótulos curtos bastam. */
const SITUACOES = ['Divulgada', 'Revogada', 'Anulada', 'Suspensa'];
const RECENT_SEARCHES_KEY = 'licitahawk:recent-searches';
const RECENT_SEARCHES_MAX = 5;

interface RecentSearchEntry {
  criteria: SavedSearchCriteria;
  timestamp: number;
}

/**
 * Tela de busca de licitações. UF e Modalidade são filtros independentes e combináveis: dá pra
 * pedir "pregões eletrônicos em GO e SP" numa busca só. O backend exige pelo menos um dos dois
 * (nunca varre a base inteira) e limita a combinação a MAX_QUERY_PAIRS pares.
 *
 * A paginação é de tamanho fixo: cada requisição traz PAGE_SIZE resultados de verdade, já filtrados,
 * e "Carregar mais" traz outros PAGE_SIZE. Uma página só vem curta quando os dados acabaram.
 */
@Component({
  selector: 'app-tender-search',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    CurrencyPipe,
    DatePipe,
    CodeBlock,
    EmptyState,
    HelpTooltip,
    ModalShell,
    MultiSelect,
    PageHeader,
    SelectField,
    Skeleton,
    TextField,
  ],
  templateUrl: './tender-search.html',
  styleUrl: './tender-search.scss',
})
export class TenderSearch {
  private readonly accountService = inject(AccountService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  protected readonly ufOptions: MultiSelectOption[] = UFS.map((uf) => ({ value: uf, label: uf }));
  protected readonly modalidadeOptions: MultiSelectOption[] = MODALIDADES.map((m) => ({
    value: m,
    label: m,
  }));
  protected readonly sortOptions: SelectFieldOption[] = [
    { value: 'desc', label: 'Mais recentes primeiro' },
    { value: 'asc', label: 'Mais antigas primeiro' },
  ];

  protected readonly situacaoOptions: MultiSelectOption[] = SITUACOES.map((s) => ({
    value: s,
    label: s,
  }));

  protected readonly selectedUfs = signal<string[]>([]);
  protected readonly selectedModalidades = signal<string[]>([]);
  protected readonly selectedSituacoes = signal<string[]>([]);
  protected readonly keyword = signal('');
  protected readonly municipio = signal('');
  protected readonly valorMin = signal<number | null>(null);
  protected readonly valorMax = signal<number | null>(null);
  protected readonly dataInicial = signal('');
  protected readonly dataFinal = signal('');
  protected readonly sort = signal<'asc' | 'desc'>('desc');

  protected readonly loading = signal(false);
  protected readonly loadingMore = signal(false);
  protected readonly searched = signal(false);
  protected readonly errorMsg = signal<string | null>(null);
  protected readonly results = signal<Tender[]>([]);
  protected readonly nextCursor = signal<string | undefined>(undefined);
  /** Última página veio curta por teto de leitura do backend, não por fim de dados. */
  protected readonly partialPage = signal(false);
  protected readonly showCurl = signal(false);
  protected readonly lastParams = signal<TenderSearchParams | null>(null);

  protected readonly showSaveModal = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  protected readonly saveName = signal('');

  protected readonly recentSearches = signal<RecentSearchEntry[]>([]);

  /** O backend nunca varre a base inteira: sem UF nem Modalidade não há índice pra consultar. */
  protected readonly missingIndexFilter = computed(
    () => this.selectedUfs().length === 0 && this.selectedModalidades().length === 0,
  );

  /** Quantas consultas de índice a combinação atual custa (1 por par UF x Modalidade). */
  protected readonly queryPairs = computed(() => {
    const ufs = this.selectedUfs().length;
    const modalidades = this.selectedModalidades().length;
    if (ufs > 0 && modalidades > 0) return ufs * modalidades;
    return Math.max(ufs, modalidades);
  });

  protected readonly tooManyPairs = computed(() => this.queryPairs() > MAX_QUERY_PAIRS);

  protected readonly canSearch = computed(() => !this.missingIndexFilter() && !this.tooManyPairs());

  protected readonly pageSize = PAGE_SIZE;

  /** Curl equivalente contra a rota REAL (`GET /v1/tenders`), pra quem quiser integrar de verdade. */
  protected readonly curlCommand = computed(() => {
    const p = this.lastParams();
    if (!p) return '';
    const query = new URLSearchParams();
    if (p.uf?.length) query.set('uf', p.uf.join(','));
    if (p.modalidade?.length) query.set('modalidade', p.modalidade.join(','));
    if (p.keyword) query.set('keyword', p.keyword);
    if (p.municipio) query.set('municipio', p.municipio);
    if (p.situacao?.length) query.set('situacao', p.situacao.join(','));
    if (p.valorMin != null) query.set('valorMin', String(p.valorMin));
    if (p.valorMax != null) query.set('valorMax', String(p.valorMax));
    if (p.dataInicial) query.set('dataInicial', p.dataInicial);
    if (p.dataFinal) query.set('dataFinal', p.dataFinal);
    if (p.sort) query.set('sort', p.sort);
    if (p.limit != null) query.set('limit', String(p.limit));

    const qs = query.toString();
    const url = `${APP_CONFIG.apiUrl}/v1/tenders${qs ? `?${qs}` : ''}`;
    return `curl -H "Authorization: Bearer SUA_API_KEY" \\\n  "${url}"`;
  });

  constructor() {
    this.loadRecentSearches();

    // Filtro salvo aplicado a partir de outra tela (filtros salvos / alertas): pré-preenche e
    // busca, depois limpa o signal para não reaplicar numa próxima visita a esta tela.
    effect(() => {
      const criteria = this.accountService.pendingSearchCriteria();
      if (!criteria) return;
      this.applyCriteria(criteria);
      this.accountService.pendingSearchCriteria.set(null);
    });
  }

  protected async search(): Promise<void> {
    if (!this.canSearch()) return;
    this.errorMsg.set(null);
    this.loading.set(true);
    this.searched.set(true);
    const params = this.buildParams();
    this.lastParams.set(params);
    try {
      const result = await this.accountService.searchTenders(params);
      this.results.set(result.data);
      this.nextCursor.set(result.next_cursor);
      this.partialPage.set(result.partial);
      this.saveRecentSearch(this.buildCriteria());
    } catch (err) {
      this.errorMsg.set(
        extractErrorMessage(err, 'Não foi possível buscar licitações. Tente novamente.'),
      );
      this.results.set([]);
      this.nextCursor.set(undefined);
      this.partialPage.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    const baseParams = this.lastParams();
    if (!cursor || !baseParams) return;
    this.loadingMore.set(true);
    try {
      const result = await this.accountService.searchTenders({ ...baseParams, cursor });
      this.results.set([...this.results(), ...result.data]);
      this.nextCursor.set(result.next_cursor);
      this.partialPage.set(result.partial);
    } catch (err) {
      this.errorMsg.set(extractErrorMessage(err, 'Não foi possível carregar mais resultados.'));
    } finally {
      this.loadingMore.set(false);
    }
  }

  protected toggleCurl(): void {
    this.showCurl.update((v) => !v);
  }

  /** Abre o detalhe em nova aba -- mesmo comportamento do dashboard antigo (ver dashboard.ts). */
  protected openDetail(id: string): void {
    const url = this.router.serializeUrl(this.router.createUrlTree(['/app/tenders', id]));
    window.open(url, '_blank');
  }

  protected exportCsv(): void {
    const columns: CsvColumn<Tender>[] = [
      { header: 'Número de controle PNCP', value: (t) => t.pncp_control_number },
      { header: 'Órgão', value: (t) => t.org_name },
      { header: 'CNPJ do órgão', value: (t) => t.org_cnpj },
      { header: 'UF', value: (t) => t.uf },
      { header: 'Município', value: (t) => t.municipio },
      { header: 'Modalidade', value: (t) => t.modalidade },
      { header: 'Objeto', value: (t) => t.objeto },
      { header: 'Valor estimado', value: (t) => t.valor_estimado },
      { header: 'Data de publicação', value: (t) => t.data_publicacao },
      { header: 'Situação', value: (t) => t.situacao },
      { header: 'Link PNCP', value: (t) => t.link_pncp },
    ];
    downloadCsv(toCsv(this.results(), columns), 'licitacoes.csv');
  }

  protected applyRecentSearch(entry: RecentSearchEntry): void {
    this.applyCriteria(entry.criteria);
  }

  protected recentSearchLabel(criteria: SavedSearchCriteria): string {
    const parts: string[] = [];
    if (criteria.uf?.length) parts.push(`UF: ${criteria.uf.join(', ')}`);
    if (criteria.modalidade?.length) parts.push(`Modalidade: ${criteria.modalidade.join(', ')}`);
    if (criteria.municipio) parts.push(`Município: ${criteria.municipio}`);
    if (criteria.keyword) parts.push(`"${criteria.keyword}"`);
    return parts.length ? parts.join(' · ') : 'Todas as licitações';
  }

  protected openSaveModal(): void {
    this.saveName.set('');
    this.saveError.set('');
    this.showSaveModal.set(true);
  }

  protected closeSaveModal(): void {
    if (this.saving()) return;
    this.showSaveModal.set(false);
  }

  protected async confirmSave(): Promise<void> {
    const name = this.saveName().trim();
    if (!name) {
      this.saveError.set('Informe um nome para o filtro.');
      return;
    }
    this.saveError.set('');
    this.saving.set(true);
    try {
      await this.accountService.createSavedSearch(name, this.buildCriteria());
      this.showSaveModal.set(false);
      this.toast.success('Filtro salvo com sucesso.');
    } catch (err) {
      this.toast.error('Não foi possível salvar este filtro.', extractErrorMessage(err, ''));
    } finally {
      this.saving.set(false);
    }
  }

  private loadRecentSearches(): void {
    try {
      const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      this.recentSearches.set(Array.isArray(parsed) ? (parsed as RecentSearchEntry[]) : []);
    } catch {
      this.recentSearches.set([]);
    }
  }

  private saveRecentSearch(criteria: SavedSearchCriteria): void {
    const key = JSON.stringify(criteria);
    const deduped = this.recentSearches().filter((e) => JSON.stringify(e.criteria) !== key);
    const updated = [{ criteria, timestamp: Date.now() }, ...deduped].slice(0, RECENT_SEARCHES_MAX);
    this.recentSearches.set(updated);
    try {
      localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
    } catch {
      /* localStorage indisponível (ex.: modo privado) -- estado em memória segue válido */
    }
  }

  private applyCriteria(criteria: SavedSearchCriteria): void {
    this.selectedUfs.set(criteria.uf ?? []);
    this.selectedModalidades.set(criteria.modalidade ?? []);
    this.selectedSituacoes.set(criteria.situacao ?? []);
    this.keyword.set(criteria.keyword ?? '');
    this.municipio.set(criteria.municipio ?? '');
    this.valorMin.set(criteria.valorMin ?? null);
    this.valorMax.set(criteria.valorMax ?? null);
    this.dataInicial.set(criteria.dataInicial ?? '');
    this.dataFinal.set(criteria.dataFinal ?? '');
    this.sort.set(criteria.sort ?? 'desc');
    void this.search();
  }

  private buildCriteria(): SavedSearchCriteria {
    return {
      uf: this.selectedUfs().length ? this.selectedUfs() : undefined,
      modalidade: this.selectedModalidades().length ? this.selectedModalidades() : undefined,
      situacao: this.selectedSituacoes().length ? this.selectedSituacoes() : undefined,
      keyword: this.keyword().trim() || undefined,
      municipio: this.municipio().trim() || undefined,
      valorMin: this.valorMin() ?? undefined,
      valorMax: this.valorMax() ?? undefined,
      dataInicial: this.dataInicial() || undefined,
      dataFinal: this.dataFinal() || undefined,
      sort: this.sort(),
    };
  }

  private buildParams(): TenderSearchParams {
    return { ...this.buildCriteria(), limit: PAGE_SIZE };
  }
}
