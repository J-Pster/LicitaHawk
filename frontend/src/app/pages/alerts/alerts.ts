import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AccountAlert, AccountService, WebhookDelivery } from '../../core/account.service';
import { AuthService } from '../../core/auth.service';
import { extractErrorMessage } from '../../core/http-error.util';
import { MODALIDADES } from '../../common/modalidades';
import { UFS } from '../../common/ufs';
import { ToastService } from '../../core/toast.service';
import {
  ConfirmDialog,
  EmptyState,
  HelpTooltip,
  ModalShell,
  PageHeader,
  SelectField,
  type SelectFieldOption,
  Skeleton,
  StatusBadge,
  type StatusTone,
  TextField,
} from '../../shared';

interface AlertFormState {
  name: string;
  uf: string;
  modalidade: string;
  keyword: string;
}

function emptyForm(): AlertFormState {
  return { name: '', uf: '', modalidade: '', keyword: '' };
}

/**
 * Tela de alertas por email. Mesmo critério de disparo de um webhook (UF + modalidade + palavra-
 * chave), só que a entrega é um email para o endereço da conta em vez de um POST num endpoint --
 * é a versão do recurso para quem não vai escrever código.
 *
 * O destinatário não é editável de propósito: o backend sempre entrega no email da conta (ver
 * account-alerts.router.ts). Por isso a tela mostra o endereço no topo, uma vez, em vez de repetir
 * uma coluna "para quem" em cada linha.
 *
 * "Copiar para um webhook" cria um webhook independente com o MESMO critério -- os critérios saem
 * do alerta guardado no backend, esta tela só informa a URL de destino.
 */
@Component({
  selector: 'app-alerts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    ConfirmDialog,
    EmptyState,
    HelpTooltip,
    ModalShell,
    PageHeader,
    SelectField,
    Skeleton,
    StatusBadge,
    TextField,
  ],
  templateUrl: './alerts.html',
  styleUrl: './alerts.scss',
})
export class Alerts implements OnInit {
  private readonly accountService = inject(AccountService);
  private readonly authService = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly ufOptions: SelectFieldOption[] = UFS.map((uf) => ({ value: uf, label: uf }));
  protected readonly modalidadeOptions: SelectFieldOption[] = MODALIDADES.map((m) => ({
    value: m,
    label: m,
  }));

  protected readonly alerts = signal<AccountAlert[]>([]);
  protected readonly loading = signal(true);
  protected readonly errorMsg = signal<string | null>(null);

  /** Email de destino de todos os alertas: o da conta. Só exibição -- nunca vira campo de form. */
  protected readonly accountEmail = signal<string | null>(null);

  protected readonly showCreateModal = signal(false);
  protected readonly creating = signal(false);
  protected readonly createForm = signal<AlertFormState>(emptyForm());
  protected readonly createError = signal('');

  protected readonly editing = signal<AccountAlert | null>(null);
  protected readonly editName = signal('');
  protected readonly savingEdit = signal(false);

  protected readonly copying = signal<AccountAlert | null>(null);
  protected readonly copyUrl = signal('');
  protected readonly copyError = signal('');
  protected readonly copyBusy = signal(false);

  protected readonly deliveriesOf = signal<AccountAlert | null>(null);
  protected readonly deliveries = signal<WebhookDelivery[]>([]);
  protected readonly deliveriesLoading = signal(false);

  protected readonly busyId = signal<string | null>(null);
  protected readonly deleting = signal<AccountAlert | null>(null);
  protected readonly deleteBusy = signal(false);

  constructor() {
    // Filtro salvo transformado em alerta (tela de filtros salvos): o alerta aceita uma
    // UF/modalidade, então usa a primeira do critério -- o usuário pode ajustar antes de criar.
    effect(() => {
      const criteria = this.accountService.pendingSearchCriteria();
      if (!criteria) return;
      this.createForm.set({
        name: '',
        uf: criteria.uf?.[0] ?? '',
        modalidade: criteria.modalidade?.[0] ?? '',
        keyword: criteria.keyword ?? '',
      });
      this.createError.set('');
      this.showCreateModal.set(true);
      this.accountService.pendingSearchCriteria.set(null);
    });
  }

  async ngOnInit(): Promise<void> {
    this.accountService
      .getMe()
      .then((account) => this.accountEmail.set(account.email))
      .catch(() => this.accountEmail.set(this.authService.currentEmail()));
    await this.reload();
  }

  private async reload(): Promise<void> {
    this.loading.set(true);
    this.errorMsg.set(null);
    try {
      this.alerts.set(await this.accountService.listAlerts());
    } catch (err) {
      this.errorMsg.set(extractErrorMessage(err, 'Não foi possível carregar seus alertas.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected displayLabel(a: AccountAlert): string {
    return a.name || `${a.uf} · ${a.modalidade}`;
  }

  protected displayCriteria(a: AccountAlert): string {
    const parts = [a.uf, a.modalidade];
    if (a.keyword) parts.push(`"${a.keyword}"`);
    return parts.join(' · ');
  }

  protected statusTone(a: AccountAlert): StatusTone {
    if (!a.active) return 'danger';
    return a.consecutive_failures > 0 ? 'warning' : 'success';
  }

  protected statusLabel(a: AccountAlert): string {
    if (!a.active) return 'Desativado (falhas seguidas)';
    if (a.consecutive_failures > 0) return `Ativo · ${a.consecutive_failures} falha(s) seguida(s)`;
    return 'Ativo';
  }

  // --- Criação -------------------------------------------------------------------------------

  protected openCreateModal(): void {
    this.createForm.set(emptyForm());
    this.createError.set('');
    this.showCreateModal.set(true);
  }

  protected closeCreateModal(): void {
    if (this.creating()) return;
    this.showCreateModal.set(false);
  }

  protected updateCreateField<K extends keyof AlertFormState>(key: K, value: AlertFormState[K]): void {
    this.createForm.update((form) => ({ ...form, [key]: value }));
  }

  protected async submitCreate(): Promise<void> {
    const form = this.createForm();
    if (!form.uf) {
      this.createError.set('Selecione uma UF.');
      return;
    }
    if (!form.modalidade) {
      this.createError.set('Selecione uma modalidade.');
      return;
    }

    this.createError.set('');
    this.creating.set(true);
    try {
      await this.accountService.createAlert({
        uf: form.uf,
        modalidade: form.modalidade,
        keyword: form.keyword.trim() || undefined,
        name: form.name.trim() || undefined,
      });
      this.showCreateModal.set(false);
      this.toast.success('Alerta criado.', `Os avisos chegam em ${this.accountEmail() ?? 'seu email'}.`);
      await this.reload();
    } catch (err) {
      this.createError.set(extractErrorMessage(err, 'Não foi possível criar o alerta.'));
    } finally {
      this.creating.set(false);
    }
  }

  // --- Edição (só o nome: o critério não é editável pela API) ---------------------------------

  protected startEdit(a: AccountAlert): void {
    this.editing.set(a);
    this.editName.set(a.name ?? '');
  }

  protected closeEdit(): void {
    if (this.savingEdit()) return;
    this.editing.set(null);
  }

  protected async confirmEdit(): Promise<void> {
    const alert = this.editing();
    if (!alert) return;
    this.savingEdit.set(true);
    try {
      const updated = await this.accountService.updateAlert(alert.id, this.editName().trim() || null);
      this.alerts.update((list) => list.map((item) => (item.id === updated.id ? updated : item)));
      this.editing.set(null);
      this.toast.success('Alerta atualizado.');
    } catch (err) {
      this.toast.error('Não foi possível salvar as alterações.', extractErrorMessage(err, ''));
    } finally {
      this.savingEdit.set(false);
    }
  }

  // --- Copiar para um webhook ------------------------------------------------------------------

  protected startCopy(a: AccountAlert): void {
    this.copying.set(a);
    this.copyUrl.set('');
    this.copyError.set('');
  }

  protected closeCopy(): void {
    if (this.copyBusy()) return;
    this.copying.set(null);
  }

  protected async confirmCopy(): Promise<void> {
    const alert = this.copying();
    if (!alert) return;
    if (!this.isValidHttpUrl(this.copyUrl())) {
      this.copyError.set('Informe uma URL de webhook válida (http:// ou https://).');
      return;
    }
    this.copyError.set('');
    this.copyBusy.set(true);
    try {
      await this.accountService.copyAlertToWebhook(alert.id, { webhook_url: this.copyUrl().trim() });
      this.copying.set(null);
      this.toast.success(
        'Webhook criado com o mesmo critério.',
        'Ele aparece em Webhooks, no menu Desenvolvedor. O alerta por email continua ativo.',
      );
    } catch (err) {
      this.copyError.set(extractErrorMessage(err, 'Não foi possível criar o webhook.'));
    } finally {
      this.copyBusy.set(false);
    }
  }

  private isValidHttpUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  // --- Testar / reativar -----------------------------------------------------------------------

  protected async runTest(a: AccountAlert): Promise<void> {
    this.busyId.set(a.id);
    const toastId = this.toast.loading('Enviando email de teste...');
    try {
      const { email } = await this.accountService.testAlert(a.id);
      this.toast.dismiss(toastId);
      this.toast.success('Email de teste enviado.', `Confira a caixa de ${email} (e o spam, no primeiro envio).`);
      await this.reload();
    } catch (err) {
      this.toast.dismiss(toastId);
      this.toast.error('Falha ao testar o alerta.', extractErrorMessage(err, ''));
    } finally {
      this.busyId.set(null);
    }
  }

  protected async reactivate(a: AccountAlert): Promise<void> {
    this.busyId.set(a.id);
    try {
      await this.accountService.reactivateAlert(a.id);
      this.toast.success('Alerta reativado.');
      await this.reload();
    } catch (err) {
      this.toast.error('Não foi possível reativar o alerta.', extractErrorMessage(err, ''));
    } finally {
      this.busyId.set(null);
    }
  }

  // --- Entregas --------------------------------------------------------------------------------

  protected async openDeliveries(a: AccountAlert): Promise<void> {
    this.deliveriesOf.set(a);
    this.deliveries.set([]);
    this.deliveriesLoading.set(true);
    try {
      this.deliveries.set(await this.accountService.getAlertDeliveries(a.id));
    } catch (err) {
      this.toast.error('Não foi possível carregar as entregas.', extractErrorMessage(err, ''));
      this.deliveriesOf.set(null);
    } finally {
      this.deliveriesLoading.set(false);
    }
  }

  protected closeDeliveries(): void {
    this.deliveriesOf.set(null);
  }

  protected deliveryTone(delivery: WebhookDelivery): StatusTone {
    return delivery.success ? 'success' : 'danger';
  }

  // --- Excluir -----------------------------------------------------------------------------

  protected askDelete(a: AccountAlert): void {
    this.deleting.set(a);
  }

  protected cancelDelete(): void {
    this.deleting.set(null);
  }

  protected async confirmDelete(): Promise<void> {
    const alert = this.deleting();
    if (!alert) return;
    this.deleteBusy.set(true);
    try {
      await this.accountService.deleteAlert(alert.id);
      this.alerts.update((list) => list.filter((item) => item.id !== alert.id));
      this.deleting.set(null);
      this.toast.success('Alerta excluído.');
    } catch (err) {
      this.toast.error('Não foi possível excluir o alerta.', extractErrorMessage(err, ''));
    } finally {
      this.deleteBusy.set(false);
    }
  }
}
