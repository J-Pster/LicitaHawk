import { DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AccountService, AccountInfo, AccountUsage, CheckoutResult, SubscriptionStatus } from '../../core/account.service';
import { extractErrorMessage } from '../../core/http-error.util';
import { ToastService } from '../../core/toast.service';
import { PageHeader, Skeleton, StatusBadge } from '../../shared';
import { CheckoutModal } from './components/checkout-modal/checkout-modal';
import { PLAN_CATALOG, PlanTier, isNextTierAbove, isUpgradeFrom, planEntry } from './plan-catalog';

/** Cadência do polling de confirmação de pagamento e limite de tentativas -- para sozinho depois
 * de ~3 minutos para nunca virar um loop infinito, e para também ao sair da tela (ver DestroyRef). */
const SUBSCRIPTION_POLL_INTERVAL_MS = 6000;
const SUBSCRIPTION_POLL_MAX_ATTEMPTS = 30;

@Component({
  selector: 'app-account',
  standalone: true,
  imports: [DatePipe, PageHeader, Skeleton, StatusBadge, CheckoutModal],
  templateUrl: './account.html',
  styleUrl: './account.scss',
})
export class Account implements OnInit {
  private readonly accountService = inject(AccountService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly planCatalog = PLAN_CATALOG;

  readonly account = signal<AccountInfo | null>(null);
  readonly usage = signal<AccountUsage | null>(null);
  readonly subscription = signal<SubscriptionStatus | null>(null);
  readonly loading = signal(true);
  readonly errorMsg = signal<string | null>(null);

  readonly checkoutPlan = signal<'starter' | 'pro' | null>(null);

  private subscriptionPollHandle: ReturnType<typeof setInterval> | null = null;
  private subscriptionPollAttempts = 0;

  constructor() {
    this.destroyRef.onDestroy(() => this.stopSubscriptionPolling());
  }

  async ngOnInit(): Promise<void> {
    const upgraded = this.route.snapshot.queryParamMap.get('upgraded');

    this.loading.set(true);
    this.errorMsg.set(null);
    try {
      const [account, usage, subscription] = await Promise.all([
        this.accountService.getMe(),
        this.accountService.getUsage(),
        this.accountService.getSubscription(),
      ]);
      this.account.set(account);
      this.usage.set(usage);
      this.subscription.set(subscription);
      if (subscription.pending_plan_tier) {
        this.startSubscriptionPolling();
      }
    } catch (err) {
      this.errorMsg.set(
        extractErrorMessage(err, 'Não foi possível carregar os dados da sua conta. Tente recarregar a página.'),
      );
    } finally {
      this.loading.set(false);
    }

    if (upgraded) {
      this.toast.success('Pagamento confirmado', 'Seu plano foi atualizado.');
      // Limpa o query param pra um refresh da página não repetir o toast.
      void this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
    }
  }

  planLabel(tier: PlanTier): string {
    return planEntry(tier).name;
  }

  /** Só mostra ação de assinar para planos acima do atual -- o fluxo de checkout não cobre
   * downgrade, então nem oferece o botão nesse caso. */
  isUpgrade(tier: PlanTier): boolean {
    const current = this.account()?.plan_tier;
    return !!current && isUpgradeFrom(current, tier);
  }

  /** Só o próximo degrau acima do atual usa o botão dourado -- com conta free, Starter E Pro
   * passavam em `isUpgrade`, então os dois viravam `.btn-primary` ao mesmo tempo (duas ações
   * primárias na mesma tela, contra a regra do design system). Os demais upgrades usam contorno. */
  isNextTier(tier: PlanTier): boolean {
    const current = this.account()?.plan_tier;
    return !!current && isNextTierAbove(current, tier);
  }

  checkoutLabel(tier: PlanTier): string {
    return this.account()?.plan_tier === 'free' ? `Assinar ${this.planLabel(tier)}` : `Fazer upgrade para ${this.planLabel(tier)}`;
  }

  openCheckout(tier: PlanTier): void {
    if (tier === 'free') {
      return;
    }
    this.checkoutPlan.set(tier);
  }

  async onCheckoutSucceeded(_result: CheckoutResult): Promise<void> {
    this.checkoutPlan.set(null);
    try {
      const subscription = await this.accountService.getSubscription();
      this.subscription.set(subscription);
      if (subscription.pending_plan_tier) {
        this.startSubscriptionPolling();
      }
    } catch {
      // Falha pontual -- o estado pendente aparece só quando o proximo carregamento conseguir.
    }
  }

  private startSubscriptionPolling(): void {
    if (this.subscriptionPollHandle) {
      return;
    }
    this.subscriptionPollAttempts = 0;
    this.subscriptionPollHandle = setInterval(
      () => void this.pollSubscription(),
      SUBSCRIPTION_POLL_INTERVAL_MS,
    );
  }

  private async pollSubscription(): Promise<void> {
    this.subscriptionPollAttempts += 1;
    if (this.subscriptionPollAttempts > SUBSCRIPTION_POLL_MAX_ATTEMPTS) {
      this.stopSubscriptionPolling();
      return;
    }

    try {
      const subscription = await this.accountService.getSubscription();
      const wasPending = !!this.subscription()?.pending_plan_tier;
      this.subscription.set(subscription);

      if (!subscription.pending_plan_tier) {
        this.stopSubscriptionPolling();
        if (wasPending) {
          const [account, usage] = await Promise.all([
            this.accountService.getMe(),
            this.accountService.getUsage(),
          ]);
          this.account.set(account);
          this.usage.set(usage);
          this.toast.success('Pagamento confirmado', 'Seu plano foi atualizado.');
        }
      }
    } catch {
      // Falha pontual de rede -- a proxima rodada do polling tenta de novo.
    }
  }

  private stopSubscriptionPolling(): void {
    if (this.subscriptionPollHandle) {
      clearInterval(this.subscriptionPollHandle);
      this.subscriptionPollHandle = null;
    }
  }
}
