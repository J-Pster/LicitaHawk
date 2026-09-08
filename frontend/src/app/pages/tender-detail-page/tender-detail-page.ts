import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { AccountService, FullTender, Tender, TenderItem } from '../../core/account.service';
import { extractErrorMessage } from '../../core/http-error.util';
import { ToastService } from '../../core/toast.service';
import {
  CollapsibleSection,
  EmptyState,
  Skeleton,
  StatusBadge,
  type StatusTone,
} from '../../shared';

const ORG_TENDERS_PAGE_SIZE = 10;

/** Rótulo legível para cada seção que o PNCP pode deixar de entregar. */
const NOME_DA_SECAO: Record<string, string> = {
  itens: 'itens',
  documentos: 'documentos',
  historico: 'histórico',
  resultados: 'resultados',
};

/**
 * Página de uma licitação (/app/tenders/:id).
 *
 * Mostra tudo que o PNCP publica sobre a contratação, com a intenção declarada de substituir a
 * página do governo: dados da compra, itens com valor unitário, resultado por item (fornecedor
 * vencedor e valor homologado), documentos para download, histórico de alterações e as outras
 * licitações do mesmo órgão.
 *
 * Usa o paramMap reativo (não o snapshot) porque navegar de um card de "outras licitações deste
 * órgão" para outro detalhe reaproveita a mesma instância do componente (mesma rota, só o :id
 * muda), então o snapshot ficaria parado no primeiro id carregado.
 */
@Component({
  selector: 'app-tender-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CurrencyPipe,
    DatePipe,
    RouterLink,
    CollapsibleSection,
    EmptyState,
    Skeleton,
    StatusBadge,
  ],
  templateUrl: './tender-detail-page.html',
  styleUrl: './tender-detail-page.scss',
})
export class TenderDetailPage {
  private readonly accountService = inject(AccountService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly id = toSignal(this.route.paramMap.pipe(map((params) => params.get('id') ?? '')), {
    initialValue: this.route.snapshot.paramMap.get('id') ?? '',
  });

  readonly loading = signal(true);
  readonly refreshing = signal(false);
  /** Segunda etapa em andamento: a tela ja tem conteudo e o detalhe esta vindo do PNCP. */
  readonly detailLoading = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly tender = signal<FullTender | null>(null);

  /** Se a licitação está na lista de "Licitações salvas" do usuário (ver /app/salvas). */
  readonly saved = signal(false);
  readonly savingTender = signal(false);

  readonly orgTenders = signal<Tender[]>([]);
  readonly orgTendersLoading = signal(false);
  readonly orgTendersError = signal<string | null>(null);
  readonly orgTendersCursor = signal<string | undefined>(undefined);
  readonly orgTendersLoadingMore = signal(false);

  readonly itensOpen = signal(true);
  readonly documentosOpen = signal(true);
  readonly historicoOpen = signal(false);
  readonly dadosBrutosOpen = signal(false);

  /** Dados da compra vindos do detalhe; caem para o payload da ingestão enquanto ele não chega. */
  readonly compra = computed(() => this.tender()?.detail?.compra ?? {});

  readonly itens = computed<TenderItem[]>(() => this.tender()?.detail?.itens ?? []);

  /** Itens que já têm vencedor definido. É o que interessa quando a licitação foi homologada. */
  readonly itensComResultado = computed(() => this.itens().filter((i) => i.resultados.length > 0));

  readonly documentos = computed(() => this.tender()?.detail?.documentos ?? []);
  readonly historico = computed(() => this.tender()?.detail?.historico ?? []);

  readonly secoesIndisponiveis = computed(() =>
    (this.tender()?.detail?.secoes_indisponiveis ?? []).map((s) => NOME_DA_SECAO[s] ?? s),
  );

  readonly valorHomologado = computed(() => {
    const bruto = this.compra()['valorTotalHomologado'];
    return typeof bruto === 'number' ? bruto : null;
  });

  readonly dadosBrutosJson = computed(() => JSON.stringify(this.compra(), null, 2));

  constructor() {
    effect(() => {
      const id = this.id();
      if (id) {
        void this.load(id);
      }
    });
  }

  openTender(id: string): void {
    void this.router.navigate(['/app/tenders', id]);
  }

  /** Tom do selo de situação. Encerrada/revogada é neutro, não erro: é o fim normal do ciclo. */
  situacaoTone(situacao: string): StatusTone {
    const texto = situacao.toLowerCase();
    if (texto.includes('divulgada') || texto.includes('publicad')) return 'success';
    if (texto.includes('anulad') || texto.includes('revogad') || texto.includes('suspens'))
      return 'danger';
    if (texto.includes('encerrad')) return 'neutral';
    return 'info';
  }

  /** Campo do detalhe cru, como texto. Usado para os campos que não têm coluna própria. */
  campo(nome: string): string {
    const valor = this.compra()[nome];
    if (valor === null || valor === undefined || valor === '') return '';
    if (typeof valor === 'boolean') return valor ? 'Sim' : 'Não';
    if (typeof valor === 'object') return JSON.stringify(valor);
    return String(valor);
  }

  /** Campo aninhado (`amparoLegal.nome`), que é como o PNCP entrega boa parte dos dados. */
  campoAninhado(caminho: string): string {
    const partes = caminho.split('.');
    let atual: unknown = this.compra();
    for (const parte of partes) {
      if (atual === null || typeof atual !== 'object') return '';
      atual = (atual as Record<string, unknown>)[parte];
    }
    if (atual === null || atual === undefined || atual === '') return '';
    return String(atual);
  }

  /** Alterna entre salvar e remover das "Licitações salvas", refletindo o estado atual do botão. */
  async toggleSaved(): Promise<void> {
    const id = this.id();
    if (!id || this.savingTender()) return;
    this.savingTender.set(true);
    try {
      if (this.saved()) {
        await this.accountService.deleteSavedTender(id);
        this.saved.set(false);
        this.toast.success('Licitação removida das salvas.');
      } else {
        await this.accountService.saveTender(id);
        this.saved.set(true);
        this.toast.success('Licitação salva.');
      }
    } catch (err) {
      this.toast.error('Não foi possível atualizar as licitações salvas.', extractErrorMessage(err, ''));
    } finally {
      this.savingTender.set(false);
    }
  }

  async copiarNumeroControle(): Promise<void> {
    const numero = this.tender()?.pncp_control_number;
    if (!numero) return;
    await navigator.clipboard.writeText(numero);
    this.toast.success('Número de controle copiado');
  }

  /** Refaz a busca no PNCP ignorando o cache. É a saída quando uma seção veio faltando. */
  async recarregarDoPncp(): Promise<void> {
    const id = this.id();
    if (!id) return;
    this.refreshing.set(true);
    try {
      const tender = await this.accountService.getTender(id, { refresh: true });
      this.tender.set(tender);
      const faltando = tender.detail?.secoes_indisponiveis ?? [];
      if (faltando.length === 0) {
        this.toast.success('Dados atualizados a partir do PNCP');
      } else {
        this.toast.warning(
          'O PNCP ainda não devolveu tudo',
          `Continua faltando: ${faltando.map((s) => NOME_DA_SECAO[s] ?? s).join(', ')}.`,
        );
      }
    } catch (err) {
      this.toast.error('Falha ao consultar o PNCP', extractErrorMessage(err, ''));
    } finally {
      this.refreshing.set(false);
    }
  }

  async loadMoreOrgTenders(): Promise<void> {
    const tender = this.tender();
    const cursor = this.orgTendersCursor();
    if (!tender || !cursor) {
      return;
    }
    this.orgTendersLoadingMore.set(true);
    try {
      const result = await this.accountService.getOrgTenders(tender.org_cnpj, {
        sort: 'desc',
        limit: ORG_TENDERS_PAGE_SIZE,
        cursor,
      });
      this.orgTenders.set([...this.orgTenders(), ...result.data]);
      this.orgTendersCursor.set(result.next_cursor);
    } catch (err) {
      this.orgTendersError.set(
        extractErrorMessage(err, 'Não foi possível carregar mais licitações.'),
      );
    } finally {
      this.orgTendersLoadingMore.set(false);
    }
  }

  /**
   * Carrega em duas etapas, e nao numa chamada só.
   *
   * O PNCP leva de segundos a dezenas de segundos quando está instável. A primeira chamada pede
   * apenas o que já está guardado e pinta a tela na hora com os dados que temos; a segunda busca o
   * detalhe completo e atualiza. Assim ninguém encara meio minuto de esqueleto para ver um objeto
   * e um valor que já estavam no nosso banco.
   */
  private async load(id: string): Promise<void> {
    this.loading.set(true);
    this.errorMsg.set(null);
    this.tender.set(null);
    this.saved.set(false);
    this.orgTenders.set([]);
    this.orgTendersCursor.set(undefined);
    try {
      const parcial = await this.accountService.getTender(id, { cachedOnly: true });
      this.tender.set(parcial);
      this.loading.set(false);

      void this.loadOrgTenders(parcial.org_cnpj);
      void this.loadSavedStatus(id);

      if (parcial.detail_pending) {
        await this.completarDetalhe(id);
      }
    } catch (err) {
      this.errorMsg.set(
        extractErrorMessage(err, 'Não foi possível carregar os detalhes desta licitação.'),
      );
    } finally {
      this.loading.set(false);
    }
  }

  /** Segunda etapa: busca o detalhe no PNCP sem tirar da tela o que já está sendo exibido. */
  private async completarDetalhe(id: string): Promise<void> {
    this.detailLoading.set(true);
    try {
      const completo = await this.accountService.getTender(id);
      // Só troca se ainda estamos na mesma licitação: o usuário pode ter navegado para outra
      // enquanto o PNCP demorava, e sobrescrever aqui trocaria o conteúdo da tela por baixo dele.
      if (this.id() === id) {
        this.tender.set(completo);
      }
    } catch {
      // Silencioso de propósito: a tela continua com os dados indexados, e o aviso de detalhe
      // ausente mais o botão "Atualizar do PNCP" já dizem o que aconteceu e o que fazer.
    } finally {
      this.detailLoading.set(false);
    }
  }

  /** Consulta se a licitação já está salva, pra pintar o botão no estado certo desde o início. */
  private async loadSavedStatus(id: string): Promise<void> {
    try {
      const saved = await this.accountService.isTenderSaved(id);
      if (this.id() === id) {
        this.saved.set(saved);
      }
    } catch {
      // Silencioso: falha aqui não impede a tela de mostrar a licitação, só deixa o botão no
      // estado padrão (não salva) -- clicar tenta salvar de novo, sem risco de duplicar.
    }
  }

  private async loadOrgTenders(cnpj: string): Promise<void> {
    this.orgTendersLoading.set(true);
    this.orgTendersError.set(null);
    try {
      const result = await this.accountService.getOrgTenders(cnpj, {
        sort: 'desc',
        limit: ORG_TENDERS_PAGE_SIZE,
      });
      this.orgTenders.set(result.data);
      this.orgTendersCursor.set(result.next_cursor);
    } catch (err) {
      this.orgTendersError.set(
        extractErrorMessage(err, 'Não foi possível carregar outras licitações deste órgão.'),
      );
    } finally {
      this.orgTendersLoading.set(false);
    }
  }
}
