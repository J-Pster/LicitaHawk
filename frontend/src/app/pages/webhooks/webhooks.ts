import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AccountService, AccountWebhook, WebhookDelivery } from '../../core/account.service';
import { extractErrorMessage } from '../../core/http-error.util';
import { MODALIDADES } from '../../common/modalidades';
import { UFS } from '../../common/ufs';
import { ToastService } from '../../core/toast.service';
import {
  CodeBlock,
  CollapsibleSection,
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

interface WebhookFormState {
  name: string;
  uf: string;
  modalidade: string;
  keyword: string;
  webhookUrl: string;
}

function emptyForm(): WebhookFormState {
  return { name: '', uf: '', modalidade: '', keyword: '', webhookUrl: '' };
}

/** Mesma cadência do feed de entregas da tela de alertas: rápido o bastante para acompanhar um
 * teste manual, devagar o bastante para não martelar a API enquanto o modal fica aberto. */
const DELIVERIES_POLL_INTERVAL_MS = 25_000;

/**
 * Visão de desenvolvedor sobre a entrega dos alertas.
 *
 * A divisão com `/app/alertas` é por CANAL de entrega: lá o alerta chega por email no endereço da
 * conta, para quem não vai escrever código; aqui ele chega como POST assinado num endpoint seu.
 * Cada tela cuida do ciclo de vida do próprio canal (criar, editar, testar, excluir), e esta ainda
 * documenta o contrato de entrega (assinatura, reentrega, log, secret) porque só ela tem endpoint.
 *
 * Para levar um alerta por email também para um endpoint, a tela de alertas tem "Copiar para um
 * webhook": copia o critério e cria um webhook independente aqui.
 *
 * Todo número documentado abaixo vem do código do backend, não de suposição:
 * `webhook-dispatcher.ts` (headers, timeout, redirect), `in-memory-webhook-queue.adapter.ts`
 * (tentativas e backoff) e `circuit-breaker.ts` (falhas consecutivas até desativar).
 */
@Component({
  selector: 'app-webhooks',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    CodeBlock,
    CollapsibleSection,
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
  templateUrl: './webhooks.html',
  styleUrl: './webhooks.scss',
})
export class Webhooks implements OnInit, OnDestroy {
  private readonly accountService = inject(AccountService);
  private readonly toast = inject(ToastService);

  protected readonly ufOptions: SelectFieldOption[] = UFS.map((uf) => ({ value: uf, label: uf }));
  protected readonly modalidadeOptions: SelectFieldOption[] = MODALIDADES.map((m) => ({
    value: m,
    label: m,
  }));

  protected readonly webhooks = signal<AccountWebhook[]>([]);
  protected readonly loading = signal(true);
  protected readonly errorMsg = signal<string | null>(null);
  protected readonly busyId = signal<string | null>(null);

  protected readonly showCreateModal = signal(false);
  protected readonly creating = signal(false);
  protected readonly createForm = signal<WebhookFormState>(emptyForm());
  protected readonly createError = signal('');

  protected readonly editing = signal<AccountWebhook | null>(null);
  protected readonly editName = signal('');
  protected readonly editUrl = signal('');
  protected readonly editError = signal('');
  protected readonly savingEdit = signal(false);

  protected readonly deleting = signal<AccountWebhook | null>(null);
  protected readonly deleteBusy = signal(false);

  protected readonly deliveriesFor = signal<AccountWebhook | null>(null);
  protected readonly deliveries = signal<WebhookDelivery[]>([]);
  protected readonly loadingDeliveries = signal(false);

  protected readonly regenerating = signal<AccountWebhook | null>(null);
  protected readonly regenerateBusy = signal(false);

  protected readonly contractOpen = signal(true);
  protected readonly signatureOpen = signal(false);
  protected readonly retryOpen = signal(false);

  private deliveriesPollHandle: ReturnType<typeof setInterval> | null = null;

  protected readonly payloadExample = `{
  "event": "tender.matched",
  "filter_id": "8f3c1e2a-...",
  "tender": {
    "pncp_control_number": "00000000000000-1-000001/2026",
    "org_cnpj": "00000000000000",
    "org_name": "Prefeitura Municipal de Exemplo",
    "uf": "GO",
    "modalidade": "Pregão Eletrônico",
    "objeto": "Aquisição de equipamentos de informática",
    "valor_estimado": 125000.5,
    "link_pncp": "https://pncp.gov.br/app/editais/..."
  }
}`;

  protected readonly headersExample = `POST /seu-endpoint HTTP/1.1
Content-Type: application/json
X-LicitaHawk-Signature: sha256=<hmac hexadecimal do corpo cru>
Idempotency-Key: <identificador único desta entrega>`;

  protected readonly verifyExample = `import { createHmac, timingSafeEqual } from 'node:crypto';

// Use o corpo CRU da requisição, antes de qualquer JSON.parse: um re-serialize muda
// bytes (ordem de chave, espaçamento) e a assinatura deixa de bater.
export function assinaturaValida(rawBody: Buffer, header: string, secret: string): boolean {
  const esperado = createHmac('sha256', secret).update(rawBody).digest('hex');
  const recebido = header.replace(/^sha256=/, '');
  const a = Buffer.from(esperado, 'hex');
  const b = Buffer.from(recebido, 'hex');
  // Comparação em tempo constante: um === comum vaza, pelo tempo de resposta,
  // quantos caracteres iniciais o atacante já acertou.
  return a.length === b.length && timingSafeEqual(a, b);
}`;

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  ngOnDestroy(): void {
    this.stopDeliveriesPoll();
  }

  private async reload(): Promise<void> {
    this.loading.set(true);
    this.errorMsg.set(null);
    try {
      this.webhooks.set(await this.accountService.listWebhooks());
    } catch (err) {
      this.errorMsg.set(extractErrorMessage(err, 'Não foi possível carregar seus endpoints.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected displayLabel(w: AccountWebhook): string {
    return w.name?.trim() || `${w.modalidade} em ${w.uf}`;
  }

  protected statusTone(w: AccountWebhook): StatusTone {
    if (!w.active) return 'danger';
    return w.consecutive_failures > 0 ? 'warning' : 'success';
  }

  protected statusLabel(w: AccountWebhook): string {
    if (!w.active) return 'Desativado';
    return w.consecutive_failures > 0 ? `${w.consecutive_failures} falha(s) seguidas` : 'Entregando';
  }

  private isValidHttpUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
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

  protected updateCreateField<K extends keyof WebhookFormState>(key: K, value: WebhookFormState[K]): void {
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
    if (!this.isValidHttpUrl(form.webhookUrl)) {
      this.createError.set('Informe uma URL de destino válida (http:// ou https://).');
      return;
    }

    this.createError.set('');
    this.creating.set(true);
    try {
      await this.accountService.createWebhook({
        uf: form.uf,
        modalidade: form.modalidade,
        webhook_url: form.webhookUrl.trim(),
        keyword: form.keyword.trim() || undefined,
        name: form.name.trim() || undefined,
      });
      this.showCreateModal.set(false);
      this.toast.success('Webhook criado.', 'Use "Testar" para conferir o primeiro POST.');
      await this.reload();
    } catch (err) {
      this.createError.set(extractErrorMessage(err, 'Não foi possível criar o webhook.'));
    } finally {
      this.creating.set(false);
    }
  }

  // --- Edição (nome e URL: o critério não é editável pela API) --------------------------------

  protected startEdit(w: AccountWebhook): void {
    this.editing.set(w);
    this.editName.set(w.name ?? '');
    this.editUrl.set(w.webhook_url);
    this.editError.set('');
  }

  protected closeEdit(): void {
    if (this.savingEdit()) return;
    this.editing.set(null);
  }

  protected async confirmEdit(): Promise<void> {
    const target = this.editing();
    if (!target) return;
    if (!this.isValidHttpUrl(this.editUrl())) {
      this.editError.set('Informe uma URL de destino válida (http:// ou https://).');
      return;
    }
    this.editError.set('');
    this.savingEdit.set(true);
    try {
      const updated = await this.accountService.updateWebhook(target.id, {
        name: this.editName().trim() || null,
        webhook_url: this.editUrl().trim(),
      });
      this.webhooks.update((list) => list.map((item) => (item.id === updated.id ? updated : item)));
      this.editing.set(null);
      this.toast.success('Webhook atualizado.');
    } catch (err) {
      this.toast.error('Não foi possível salvar as alterações.', extractErrorMessage(err, ''));
    } finally {
      this.savingEdit.set(false);
    }
  }

  // --- Excluir --------------------------------------------------------------------------------

  protected askDelete(w: AccountWebhook): void {
    this.deleting.set(w);
  }

  protected cancelDelete(): void {
    this.deleting.set(null);
  }

  protected async confirmDelete(): Promise<void> {
    const target = this.deleting();
    if (!target) return;
    this.deleteBusy.set(true);
    try {
      await this.accountService.deleteWebhook(target.id);
      this.webhooks.update((list) => list.filter((item) => item.id !== target.id));
      this.deleting.set(null);
      this.toast.success('Webhook excluído.');
    } catch (err) {
      this.toast.error('Não foi possível excluir o webhook.', extractErrorMessage(err, ''));
    } finally {
      this.deleteBusy.set(false);
    }
  }

  protected async test(w: AccountWebhook): Promise<void> {
    this.busyId.set(w.id);
    try {
      await this.accountService.testWebhook(w.id);
      this.toast.success('Disparo de teste enviado', 'Confira o resultado em "Ver entregas".');
    } catch (err) {
      this.toast.error('Falha ao disparar o teste', extractErrorMessage(err, ''));
    } finally {
      this.busyId.set(null);
    }
  }

  protected async reactivate(w: AccountWebhook): Promise<void> {
    this.busyId.set(w.id);
    try {
      await this.accountService.reactivateWebhook(w.id);
      this.toast.success('Endpoint reativado', 'O contador de falhas voltou a zero.');
      await this.reload();
    } catch (err) {
      this.toast.error('Falha ao reativar', extractErrorMessage(err, ''));
    } finally {
      this.busyId.set(null);
    }
  }

  protected openDeliveries(w: AccountWebhook): void {
    this.deliveriesFor.set(w);
    void this.loadDeliveries(w.id);
    this.stopDeliveriesPoll();
    this.deliveriesPollHandle = setInterval(() => {
      void this.loadDeliveries(w.id);
    }, DELIVERIES_POLL_INTERVAL_MS);
  }

  protected closeDeliveries(): void {
    this.stopDeliveriesPoll();
    this.deliveriesFor.set(null);
    this.deliveries.set([]);
  }

  private async loadDeliveries(id: string): Promise<void> {
    this.loadingDeliveries.set(true);
    try {
      const rows = await this.accountService.getWebhookDeliveries(id);
      // Mais recente primeiro: quem abre este feed acabou de disparar um teste.
      this.deliveries.set([...rows].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)));
    } catch (err) {
      this.toast.error('Falha ao carregar as entregas', extractErrorMessage(err, ''));
    } finally {
      this.loadingDeliveries.set(false);
    }
  }

  private stopDeliveriesPoll(): void {
    if (this.deliveriesPollHandle !== null) {
      clearInterval(this.deliveriesPollHandle);
      this.deliveriesPollHandle = null;
    }
  }

  protected async confirmRegenerate(): Promise<void> {
    const target = this.regenerating();
    if (!target) return;
    this.regenerateBusy.set(true);
    try {
      await this.accountService.regenerateWebhookSecret(target.id);
      this.toast.success(
        'Secret regenerado',
        'Atualize o segredo no seu servidor: as próximas entregas usam o novo.',
      );
      this.regenerating.set(null);
      await this.reload();
    } catch (err) {
      this.toast.error('Falha ao regenerar o secret', extractErrorMessage(err, ''));
    } finally {
      this.regenerateBusy.set(false);
    }
  }
}
