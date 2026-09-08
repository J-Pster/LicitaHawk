import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AccountInfo, AccountService, AccountUsage, AccountWebhook } from '../../core/account.service';
import { extractErrorMessage } from '../../core/http-error.util';
import { PageHeader, Skeleton } from '../../shared';

interface OnboardingStep {
  readonly label: string;
  readonly route: string;
  readonly done: boolean;
}

/**
 * Nova porta de entrada do produto (`/app/inicio`), no lugar das antigas abas do
 * `/app/dashboard`. Junta um resumo de conta + uso + atalhos, pra dar orientacao
 * de onde ir em vez de cair direto na busca.
 */
@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [RouterLink, PageHeader, Skeleton],
  templateUrl: './overview.html',
  styleUrl: './overview.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Overview {
  private readonly accountService = inject(AccountService);

  readonly account = signal<AccountInfo | null>(null);
  readonly usage = signal<AccountUsage | null>(null);
  readonly webhooks = signal<AccountWebhook[] | null>(null);
  readonly loading = signal(true);
  readonly errorMsg = signal<string | null>(null);

  /** Banner de chave recem-criada: quem exibe/copia a chave e a tela de API keys, aqui e so o aviso. */
  readonly justProvisionedApiKey = this.accountService.justProvisionedApiKey;

  /** Lista central de filtros salvos (AccountService e o unico dono do estado). */
  readonly savedSearchesCount = computed(() => this.accountService.savedSearches().length);

  readonly activeWebhooksCount = computed(
    () => this.webhooks()?.filter((webhook) => webhook.active).length ?? 0,
  );

  readonly usagePercent = computed(() => {
    const u = this.usage();
    if (!u || u.monthlyLimit <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((u.requestsThisMonth / u.monthlyLimit) * 100));
  });

  readonly planLabel = computed(() => {
    switch (this.account()?.plan_tier) {
      case 'starter':
        return 'Starter';
      case 'pro':
        return 'Pro';
      default:
        return 'Free';
    }
  });

  readonly hasApiKey = computed(() => this.account()?.has_api_key ?? false);

  readonly onboardingSteps = computed<OnboardingStep[]>(() => [
    { label: 'Criar uma API key', route: '/app/api-keys', done: this.hasApiKey() },
    { label: 'Salvar um filtro de busca', route: '/app/filtros', done: this.savedSearchesCount() > 0 },
    { label: 'Criar um alerta', route: '/app/alertas', done: this.activeWebhooksCount() > 0 },
    { label: 'Conectar o servidor MCP', route: '/app/mcp', done: false },
  ]);

  constructor() {
    void this.load();
  }

  dismissApiKeyBanner(): void {
    this.accountService.justProvisionedApiKey.set(null);
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.errorMsg.set(null);
    try {
      await Promise.all([
        this.accountService.getMe().then((account) => this.account.set(account)),
        this.accountService.getUsage().then((usage) => this.usage.set(usage)),
        this.accountService.listWebhooks().then((webhooks) => this.webhooks.set(webhooks)),
        this.accountService.refreshSavedSearches(),
      ]);
    } catch (err) {
      this.errorMsg.set(
        extractErrorMessage(
          err,
          'Não foi possível carregar o resumo da sua conta. Tente recarregar a página.',
        ),
      );
    } finally {
      this.loading.set(false);
    }
  }
}
