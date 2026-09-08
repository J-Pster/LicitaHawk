import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AccountService, ApiKeySummary } from '../../core/account.service';
import { extractErrorMessage } from '../../core/http-error.util';
import { ToastService } from '../../core/toast.service';
import { APP_CONFIG } from '../../config';
import {
  CodeBlock,
  ConfirmDialog,
  EmptyState,
  ModalShell,
  PageHeader,
  Skeleton,
  StatusBadge,
  type StatusTone,
  TextField,
} from '../../shared';

/** Exemplo estático (não é a chave real de ninguém) só para mostrar o formato do header. */
const CURL_EXAMPLE = `curl -s "${APP_CONFIG.apiUrl}/v1/tenders?uf=GO&keyword=software" \\\n  -H "Authorization: Bearer SUA_API_KEY"`;

/**
 * Gestão de chaves de API. A chave crua só existe uma vez: tanto a criação por aqui quanto o
 * provisionamento automático do primeiro login escrevem no mesmo signal
 * `AccountService.justProvisionedApiKey`, então o bloco de revelação abaixo cobre os dois casos
 * sem precisar de estado próprio.
 */
@Component({
  selector: 'app-api-keys',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    CodeBlock,
    ConfirmDialog,
    EmptyState,
    ModalShell,
    PageHeader,
    Skeleton,
    StatusBadge,
    TextField,
  ],
  templateUrl: './api-keys.html',
  styleUrl: './api-keys.scss',
})
export class ApiKeys implements OnInit {
  protected readonly accountService = inject(AccountService);
  private readonly toastService = inject(ToastService);

  protected readonly curlExample = CURL_EXAMPLE;

  readonly keys = signal<ApiKeySummary[]>([]);
  readonly loading = signal(true);
  readonly errorMsg = signal<string | null>(null);

  // --- Criação ---
  readonly createOpen = signal(false);
  readonly creating = signal(false);
  readonly createName = signal('');
  readonly createNoExpiry = signal(true);
  readonly createExpiresAt = signal('');
  readonly createNameError = signal('');
  readonly createDateError = signal('');

  // --- Edição ---
  readonly editing = signal<ApiKeySummary | null>(null);
  readonly editName = signal('');
  readonly editNoExpiry = signal(true);
  readonly editExpiresAt = signal('');
  readonly editSaving = signal(false);
  readonly editNameError = signal('');
  readonly editDateError = signal('');

  // --- Revogação ---
  readonly revokeTarget = signal<ApiKeySummary | null>(null);
  readonly revoking = signal(false);

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.errorMsg.set(null);
    try {
      this.keys.set(await this.accountService.listApiKeys());
    } catch (err) {
      this.errorMsg.set(extractErrorMessage(err, 'Não foi possível carregar as chaves de API.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected statusTone(key: ApiKeySummary): StatusTone {
    if (!key.active) return 'danger';
    if (this.isExpired(key)) return 'warning';
    return 'success';
  }

  protected statusLabel(key: ApiKeySummary): string {
    if (!key.active) return 'Revogada';
    if (this.isExpired(key)) return 'Expirada';
    return 'Ativa';
  }

  private isExpired(key: ApiKeySummary): boolean {
    return !!key.expires_at && new Date(key.expires_at).getTime() < Date.now();
  }

  // --- Criação ---

  openCreate(): void {
    this.createName.set('');
    this.createNoExpiry.set(true);
    this.createExpiresAt.set('');
    this.createNameError.set('');
    this.createDateError.set('');
    this.createOpen.set(true);
  }

  closeCreate(): void {
    if (this.creating()) return;
    this.createOpen.set(false);
  }

  async submitCreate(): Promise<void> {
    this.createNameError.set('');
    this.createDateError.set('');
    const name = this.createName().trim();
    if (!name) {
      this.createNameError.set('Informe um nome para a chave.');
      return;
    }
    if (!this.createNoExpiry() && !this.createExpiresAt()) {
      this.createDateError.set('Escolha uma data ou marque "Não expira".');
      return;
    }

    this.creating.set(true);
    try {
      await this.accountService.createApiKey(
        name,
        this.createNoExpiry() ? null : this.createExpiresAt(),
      );
      this.createOpen.set(false);
      this.toastService.success('Chave criada', 'Copie agora: ela não será mostrada de novo.');
      await this.load();
    } catch (err) {
      this.createNameError.set(extractErrorMessage(err, 'Não foi possível criar a chave.'));
    } finally {
      this.creating.set(false);
    }
  }

  // --- Edição ---

  startEdit(key: ApiKeySummary): void {
    this.editing.set(key);
    this.editName.set(key.name);
    this.editNoExpiry.set(!key.expires_at);
    this.editExpiresAt.set(key.expires_at ? key.expires_at.slice(0, 10) : '');
    this.editNameError.set('');
    this.editDateError.set('');
  }

  closeEdit(): void {
    if (this.editSaving()) return;
    this.editing.set(null);
  }

  async submitEdit(): Promise<void> {
    const key = this.editing();
    if (!key) return;

    this.editNameError.set('');
    this.editDateError.set('');
    const name = this.editName().trim();
    if (!name) {
      this.editNameError.set('O nome não pode ficar vazio.');
      return;
    }
    if (!this.editNoExpiry() && !this.editExpiresAt()) {
      this.editDateError.set('Escolha uma data ou marque "Não expira".');
      return;
    }

    this.editSaving.set(true);
    try {
      const updated = await this.accountService.updateApiKey(key.id, {
        name,
        expires_at: this.editNoExpiry() ? null : this.editExpiresAt(),
      });
      this.keys.set(this.keys().map((k) => (k.id === updated.id ? updated : k)));
      this.editing.set(null);
      this.toastService.success('Chave atualizada');
    } catch (err) {
      this.editNameError.set(extractErrorMessage(err, 'Não foi possível salvar as alterações.'));
    } finally {
      this.editSaving.set(false);
    }
  }

  // --- Revogação ---

  askRevoke(key: ApiKeySummary): void {
    this.revokeTarget.set(key);
  }

  async confirmRevoke(): Promise<void> {
    const key = this.revokeTarget();
    if (!key) return;

    this.revoking.set(true);
    try {
      await this.accountService.revokeApiKey(key.id);
      this.keys.set(this.keys().map((k) => (k.id === key.id ? { ...k, active: false } : k)));
      this.revokeTarget.set(null);
      this.toastService.success('Chave revogada');
    } catch (err) {
      this.toastService.error('Não foi possível revogar a chave', extractErrorMessage(err, ''));
    } finally {
      this.revoking.set(false);
    }
  }

  // --- Copiar ---

  async copy(value: string, message = 'Copiado para a área de transferência'): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.toastService.success(message);
    } catch {
      this.toastService.error('Não foi possível copiar');
    }
  }

  dismissReveal(): void {
    this.accountService.justProvisionedApiKey.set(null);
  }
}
