import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AccountService, CheckoutResult } from '../../core/account.service';
import { digitsOnly, validateCpfCnpj } from '../account/cpf-cnpj.util';

type Plan = 'starter' | 'pro';

const PLAN_DETAILS: Record<Plan, { label: string; price: string }> = {
  starter: { label: 'Starter', price: 'R$ 49/mês' },
  pro: { label: 'Pro', price: 'R$ 149/mês' },
};

const PLAN_LIST: { key: Plan; label: string; price: string }[] = [
  { key: 'starter', ...PLAN_DETAILS.starter },
  { key: 'pro', ...PLAN_DETAILS.pro },
];

/** Mesmo teto usado em account.ts: para sozinho depois de ~3 minutos, nunca vira loop infinito
 * (some também no destroy, ver ngOnDestroy/stopPolling). */
const SUBSCRIPTION_POLL_INTERVAL_MS = 6000;
const SUBSCRIPTION_POLL_MAX_ATTEMPTS = 30;

@Component({
  selector: 'app-payment',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './payment.html',
  styleUrl: './payment.scss',
})
export class Payment implements OnInit, OnDestroy {
  private readonly accountService = inject(AccountService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly planDetails = PLAN_DETAILS;
  readonly planList = PLAN_LIST;
  readonly selectedPlan = signal<Plan>('starter');
  readonly loading = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly checkoutResult = signal<CheckoutResult | null>(null);
  readonly polling = signal(false);

  name = '';
  cpfCnpj = '';

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private pollAttempts = 0;

  ngOnInit(): void {
    const requestedPlan = this.route.snapshot.queryParamMap.get('plan');
    if (requestedPlan === 'starter' || requestedPlan === 'pro') {
      this.selectedPlan.set(requestedPlan);
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  selectPlan(plan: Plan): void {
    if (this.checkoutResult()) {
      return;
    }
    this.selectedPlan.set(plan);
  }

  async onSubmit(): Promise<void> {
    this.errorMsg.set(null);

    if (!this.name.trim()) {
      this.errorMsg.set('Informe o nome completo ou razão social.');
      return;
    }
    // Mesma validação (formato + dígito verificador) do checkout-modal da tela de conta -- rota
    // autenticada que mexe com cobrança real, não duplica o algoritmo.
    const cpfCnpjError = validateCpfCnpj(this.cpfCnpj);
    if (cpfCnpjError) {
      this.errorMsg.set(cpfCnpjError);
      return;
    }

    this.loading.set(true);
    try {
      const result = await this.accountService.checkout(
        this.selectedPlan(),
        digitsOnly(this.cpfCnpj),
        this.name.trim(),
      );
      this.checkoutResult.set(result);
      this.startPolling();
    } catch (err) {
      this.errorMsg.set(this.extractErrorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  private startPolling(): void {
    this.polling.set(true);
    this.pollAttempts = 0;
    this.pollHandle = setInterval(async () => {
      this.pollAttempts += 1;
      if (this.pollAttempts > SUBSCRIPTION_POLL_MAX_ATTEMPTS) {
        this.stopPolling();
        return;
      }
      try {
        const subscription = await this.accountService.getSubscription();
        if (subscription.plan_tier === this.selectedPlan()) {
          this.stopPolling();
          await this.router.navigate(['/app/conta'], { queryParams: { upgraded: 1 } });
        }
      } catch {
        // silently retry on next interval tick
      }
    }, SUBSCRIPTION_POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.polling.set(false);
  }

  private extractErrorMessage(err: unknown): string {
    const httpErr = err as { error?: { error?: { message?: string } } };
    return httpErr?.error?.error?.message || 'Não foi possível iniciar o pagamento. Tente novamente.';
  }
}
