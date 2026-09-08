import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AccountService, AccountUsage, DailyUsageResponse } from '../../core/account.service';
import { extractErrorMessage } from '../../core/http-error.util';
import { EmptyState, PageHeader, Skeleton } from '../../shared';
import { DailyUsageChart } from './components/daily-usage-chart/daily-usage-chart';
import { UsageBreakdownChart } from './components/usage-breakdown-chart/usage-breakdown-chart';

type UsageTone = 'normal' | 'warning' | 'danger';

const WARNING_THRESHOLD = 0.8;
const DANGER_THRESHOLD = 0.95;

@Component({
  selector: 'app-usage',
  standalone: true,
  imports: [RouterLink, PageHeader, Skeleton, EmptyState, DailyUsageChart, UsageBreakdownChart],
  templateUrl: './usage.html',
  styleUrl: './usage.scss',
})
export class Usage implements OnInit {
  private readonly accountService = inject(AccountService);

  readonly usage = signal<AccountUsage | null>(null);
  readonly daily = signal<DailyUsageResponse | null>(null);
  readonly loading = signal(true);
  readonly errorMsg = signal<string | null>(null);

  readonly usagePercent = computed(() => {
    const u = this.usage();
    if (!u || u.monthlyLimit <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((u.requestsThisMonth / u.monthlyLimit) * 100));
  });

  readonly usageTone = computed<UsageTone>(() => {
    const u = this.usage();
    if (!u || u.monthlyLimit <= 0) {
      return 'normal';
    }
    const ratio = u.requestsThisMonth / u.monthlyLimit;
    if (ratio >= DANGER_THRESHOLD) {
      return 'danger';
    }
    if (ratio >= WARNING_THRESHOLD) {
      return 'warning';
    }
    return 'normal';
  });

  readonly isNearLimit = computed(() => this.usageTone() !== 'normal');

  /** Conta nova sem nenhuma chamada nos últimos 30 dias -- mostra um convite a usar o produto em
   * vez de gráficos zerados, que não dizem nada de útil pra quem ainda não começou. */
  readonly hasNoUsage = computed(() => {
    const d = this.daily();
    if (!d) {
      return false;
    }
    return d.totals.api + d.totals.mcp + d.totals.ui + d.totals.webhook + d.totals.email === 0;
  });

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    this.errorMsg.set(null);
    try {
      const [usage, daily] = await Promise.all([
        this.accountService.getUsage(),
        this.accountService.getDailyUsage(),
      ]);
      this.usage.set(usage);
      this.daily.set(daily);
    } catch (err) {
      this.errorMsg.set(
        extractErrorMessage(err, 'Não foi possível carregar o uso da sua conta. Tente recarregar a página.'),
      );
    } finally {
      this.loading.set(false);
    }
  }
}
