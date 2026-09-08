import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AccountService, SavedSearch } from '../../core/account.service';
import { extractErrorMessage } from '../../core/http-error.util';
import { ToastService } from '../../core/toast.service';
import {
  ConfirmDialog,
  EmptyState,
  HelpTooltip,
  ModalShell,
  PageHeader,
  Skeleton,
  StatusBadge,
  TextField,
} from '../../shared';

interface SavedFilterRow extends SavedSearch {
  newCount: number;
}

/**
 * Tela dedicada de filtros salvos, antes um painel dentro do dashboard. Lê o
 * estado central do `AccountService` -- nunca mantém cópia própria da lista.
 */
@Component({
  selector: 'app-saved-filters',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    DatePipe,
    RouterLink,
    ConfirmDialog,
    EmptyState,
    HelpTooltip,
    ModalShell,
    PageHeader,
    Skeleton,
    StatusBadge,
    TextField,
  ],
  templateUrl: './saved-filters.html',
  styleUrl: './saved-filters.scss',
})
export class SavedFilters implements OnInit {
  private readonly accountService = inject(AccountService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  protected readonly loading = computed(() => this.accountService.savedSearchesLoading());
  protected readonly items = computed<SavedFilterRow[]>(() => {
    const counts = this.accountService.savedSearchNewCounts();
    return this.accountService
      .savedSearches()
      .map((s) => ({ ...s, newCount: counts[s.saved_search_id] ?? 0 }));
  });

  protected readonly errorMsg = signal<string | null>(null);
  protected readonly applyingId = signal<string | null>(null);

  protected readonly editing = signal<SavedFilterRow | null>(null);
  protected readonly editName = signal('');
  protected readonly editError = signal('');
  protected readonly savingEdit = signal(false);

  protected readonly deleting = signal<SavedFilterRow | null>(null);
  protected readonly deleteBusy = signal(false);

  async ngOnInit(): Promise<void> {
    this.errorMsg.set(null);
    try {
      await this.accountService.refreshSavedSearches();
    } catch (err) {
      this.errorMsg.set(extractErrorMessage(err, 'Não foi possível carregar seus filtros salvos.'));
    }
  }

  protected criteriaBadges(item: SavedSearch): string[] {
    const c = item.criteria;
    if (c.uf?.length) return c.uf;
    if (c.modalidade?.length) return c.modalidade;
    return [];
  }

  protected criteriaSummary(item: SavedSearch): string | null {
    const c = item.criteria;
    const parts: string[] = [];
    if (c.keyword) {
      parts.push(`"${c.keyword}"`);
    }
    if (c.valorMin != null || c.valorMax != null) {
      const min = c.valorMin != null ? this.formatCurrency(c.valorMin) : '...';
      const max = c.valorMax != null ? this.formatCurrency(c.valorMax) : '...';
      parts.push(`${min} - ${max}`);
    }
    if (c.dataInicial || c.dataFinal) {
      parts.push(`${c.dataInicial || '...'} até ${c.dataFinal || '...'}`);
    }
    return parts.length ? parts.join(' · ') : null;
  }

  protected async applyToSearch(item: SavedFilterRow): Promise<void> {
    this.errorMsg.set(null);
    this.applyingId.set(item.saved_search_id);
    try {
      this.accountService.applySavedCriteria(item.criteria);
      await this.accountService.markSavedSearchSeen(item.saved_search_id);
      void this.router.navigate(['/app/buscar']);
    } catch (err) {
      this.errorMsg.set(extractErrorMessage(err, 'Não foi possível aplicar este filtro.'));
    } finally {
      this.applyingId.set(null);
    }
  }

  protected convertToAlert(item: SavedFilterRow): void {
    this.accountService.applySavedCriteria(item.criteria);
    void this.router.navigate(['/app/alertas']);
  }

  protected startEdit(item: SavedFilterRow): void {
    this.editing.set(item);
    this.editName.set(item.name);
    this.editError.set('');
  }

  protected closeEdit(): void {
    if (this.savingEdit()) return;
    this.editing.set(null);
  }

  protected async confirmEdit(): Promise<void> {
    const item = this.editing();
    if (!item) return;
    const name = this.editName().trim();
    if (!name) {
      this.editError.set('Informe um nome para o filtro salvo.');
      return;
    }
    this.editError.set('');
    this.savingEdit.set(true);
    try {
      await this.accountService.updateSavedSearch(item.saved_search_id, { name });
      this.editing.set(null);
      this.toast.success('Filtro renomeado.');
    } catch (err) {
      this.toast.error('Não foi possível renomear este filtro.', extractErrorMessage(err, ''));
    } finally {
      this.savingEdit.set(false);
    }
  }

  protected askDelete(item: SavedFilterRow): void {
    this.deleting.set(item);
  }

  protected cancelDelete(): void {
    this.deleting.set(null);
  }

  protected async confirmDelete(): Promise<void> {
    const item = this.deleting();
    if (!item) return;
    this.deleteBusy.set(true);
    try {
      await this.accountService.deleteSavedSearch(item.saved_search_id);
      this.deleting.set(null);
      this.toast.success('Filtro excluído.');
    } catch (err) {
      this.toast.error('Não foi possível excluir este filtro.', extractErrorMessage(err, ''));
    } finally {
      this.deleteBusy.set(false);
    }
  }

  private formatCurrency(value: number): string {
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
}
