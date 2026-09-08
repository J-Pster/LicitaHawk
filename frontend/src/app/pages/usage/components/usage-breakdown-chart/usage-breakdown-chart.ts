import { Component, computed, input } from '@angular/core';
import { DailyUsageTotals } from '../../../../core/account.service';

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface Slice {
  key: keyof DailyUsageTotals;
  label: string;
  value: number;
  percent: number;
  dashArray: string;
  dashOffset: number;
}

const SLICE_ORDER: { key: keyof DailyUsageTotals; label: string }[] = [
  { key: 'api', label: 'API' },
  { key: 'mcp', label: 'MCP' },
  { key: 'ui', label: 'Dashboard' },
  { key: 'webhook', label: 'Webhook' },
  { key: 'email', label: 'Email' },
];

/** Donut de proporção de uso por origem (API/MCP/Dashboard/Webhook/Email), SVG puro (sem lib nova). A
 * legenda por baixo já é a descrição textual equivalente ao desenho -- valor e percentual de cada
 * fatia ficam visíveis pra todo mundo, não só num tooltip. */
@Component({
  selector: 'app-usage-breakdown-chart',
  standalone: true,
  templateUrl: './usage-breakdown-chart.html',
  styleUrl: './usage-breakdown-chart.scss',
})
export class UsageBreakdownChart {
  readonly totals = input.required<DailyUsageTotals>();

  readonly radius = RADIUS;

  readonly total = computed(() => {
    const t = this.totals();
    return t.api + t.mcp + t.ui + t.webhook + t.email;
  });

  readonly hasData = computed(() => this.total() > 0);

  readonly slices = computed<Slice[]>(() => {
    const t = this.totals();
    const total = this.total();
    let cumulative = 0;

    return SLICE_ORDER.map(({ key, label }) => {
      const value = t[key];
      if (total === 0) {
        return { key, label, value, percent: 0, dashArray: `0 ${CIRCUMFERENCE}`, dashOffset: 0 };
      }
      const length = (value / total) * CIRCUMFERENCE;
      const dashOffset = -cumulative;
      cumulative += length;
      return {
        key,
        label,
        value,
        percent: Math.round((value / total) * 100),
        dashArray: `${length} ${CIRCUMFERENCE - length}`,
        dashOffset,
      };
    });
  });
}
