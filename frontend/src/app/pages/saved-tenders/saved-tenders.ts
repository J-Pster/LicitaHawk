import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AccountService, SavedTender } from '../../core/account.service';
import { extractErrorMessage } from '../../core/http-error.util';
import { ToastService } from '../../core/toast.service';
import {
  ConfirmDialog,
  DragScroll,
  EmptyState,
  ModalShell,
  PageHeader,
  Skeleton,
  StatusBadge,
  type StatusTone,
} from '../../shared';

const MAX_NOTE_LENGTH = 500;

interface PrazoInfo {
  label: string;
  tone: StatusTone;
}

/**
 * Tela de licitações salvas (favoritos com nota pessoal). Diferente de Filtros salvos e Alertas,
 * aqui não há estado central no `AccountService`: só esta tela e o botão de salvar do detalhe
 * consomem o endpoint, e não há badge de contagem em outro lugar pra manter sincronizado --
 * então a lista vive como estado local mesmo (ver DESIGN.md: estado central é pra quando duas
 * telas realmente precisam ver o mesmo dado ao mesmo tempo).
 */
@Component({
  selector: 'app-saved-tenders',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    CurrencyPipe,
    DatePipe,
    RouterLink,
    ConfirmDialog,
    DragScroll,
    EmptyState,
    ModalShell,
    PageHeader,
    Skeleton,
    StatusBadge,
  ],
  templateUrl: './saved-tenders.html',
  styleUrl: './saved-tenders.scss',
})
export class SavedTenders implements OnInit {
  private readonly accountService = inject(AccountService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  protected readonly maxNoteLength = MAX_NOTE_LENGTH;

  protected readonly loading = signal(true);
  protected readonly items = signal<SavedTender[]>([]);
  protected readonly errorMsg = signal<string | null>(null);

  protected readonly editing = signal<SavedTender | null>(null);
  protected readonly editNote = signal('');
  protected readonly savingEdit = signal(false);

  protected readonly deleting = signal<SavedTender | null>(null);
  protected readonly deleteBusy = signal(false);

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.errorMsg.set(null);
    try {
      const items = await this.accountService.listSavedTenders();
      this.items.set(items);
    } catch (err) {
      this.errorMsg.set(
        extractErrorMessage(err, 'Não foi possível carregar suas licitações salvas.'),
      );
    } finally {
      this.loading.set(false);
    }
  }

  protected openTender(pncpControlNumber: string): void {
    void this.router.navigate(['/app/tenders', pncpControlNumber]);
  }

  /** Quanto falta (ou já passou) do prazo de propostas -- o motivo real de existir esta tela. */
  protected prazoInfo(dataEncerramento: string | null): PrazoInfo {
    if (!dataEncerramento) {
      return { label: 'sem prazo informado', tone: 'neutral' };
    }
    const deadline = Date.parse(dataEncerramento);
    if (Number.isNaN(deadline)) {
      return { label: 'sem prazo informado', tone: 'neutral' };
    }
    const diffMs = deadline - Date.now();
    if (diffMs <= 0) {
      return { label: 'prazo encerrado', tone: 'neutral' };
    }
    const dias = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (dias <= 3) {
      return { label: dias === 1 ? 'encerra amanhã' : `encerra em ${dias} dias`, tone: 'warning' };
    }
    return { label: `encerra em ${dias} dias`, tone: 'info' };
  }

  protected startEditNote(item: SavedTender): void {
    this.editing.set(item);
    this.editNote.set(item.note ?? '');
  }

  protected closeEditNote(): void {
    if (this.savingEdit()) return;
    this.editing.set(null);
  }

  protected async confirmEditNote(): Promise<void> {
    const item = this.editing();
    if (!item) return;
    if (this.editNote().length > MAX_NOTE_LENGTH) {
      return;
    }
    this.savingEdit.set(true);
    try {
      const note = this.editNote().trim() || null;
      const updated = await this.accountService.updateSavedTenderNote(item.pncp_control_number, note);
      this.items.update((list) =>
        list.map((i) => (i.pncp_control_number === updated.pncp_control_number ? updated : i)),
      );
      this.editing.set(null);
      this.toast.success('Nota salva.');
    } catch (err) {
      this.toast.error('Não foi possível salvar a nota.', extractErrorMessage(err, ''));
    } finally {
      this.savingEdit.set(false);
    }
  }

  protected askDelete(item: SavedTender): void {
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
      await this.accountService.deleteSavedTender(item.pncp_control_number);
      this.items.update((list) =>
        list.filter((i) => i.pncp_control_number !== item.pncp_control_number),
      );
      this.deleting.set(null);
      this.toast.success('Licitação removida das salvas.');
    } catch (err) {
      this.toast.error('Não foi possível remover.', extractErrorMessage(err, ''));
    } finally {
      this.deleteBusy.set(false);
    }
  }
}
