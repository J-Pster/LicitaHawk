import { Component, computed, input } from '@angular/core';
import { DailyUsageDay } from '../../../../core/account.service';

interface Segment {
  y: number;
  height: number;
}

interface Bar {
  date: string;
  shortLabel: string;
  showLabel: boolean;
  api: Segment;
  mcp: Segment;
  ui: Segment;
  webhook: Segment;
  email: Segment;
  x: number;
  tooltip: string;
}

const PLOT_X0 = 42;
const PLOT_X1 = 612;
const PLOT_Y0 = 10;
const PLOT_Y1 = 152;
const BAR_GAP = 2;

/** Barras empilhadas do uso diário por origem, em SVG puro (sem biblioteca de gráfico). Traz uma
 * tabela `.sr-only` equivalente aos dados, porque o `<title>` por barra só ajuda no hover/foco de
 * uma barra por vez -- quem usa leitor de tela precisa da série inteira de uma vez. */
@Component({
  selector: 'app-daily-usage-chart',
  standalone: true,
  templateUrl: './daily-usage-chart.html',
  styleUrl: './daily-usage-chart.scss',
})
export class DailyUsageChart {
  readonly days = input.required<DailyUsageDay[]>();

  private readonly maxTotal = computed(() => {
    return Math.max(1, ...this.days().map((d) => d.total_count));
  });

  readonly gridLines = computed(() => {
    const max = this.maxTotal();
    const steps = [0, 0.5, 1];
    return steps.map((fraction) => {
      const value = Math.round(max * fraction);
      const y = PLOT_Y1 - (PLOT_Y1 - PLOT_Y0) * fraction;
      return { value, y };
    });
  });

  readonly bars = computed<Bar[]>(() => {
    const days = this.days();
    const max = this.maxTotal();
    const plotHeight = PLOT_Y1 - PLOT_Y0;

    return days.map((day, index) => {
      const x = PLOT_X0 + index * ((PLOT_X1 - PLOT_X0) / days.length);

      const apiHeight = (day.api_count / max) * plotHeight;
      const mcpHeight = (day.mcp_count / max) * plotHeight;
      const uiHeight = (day.ui_count / max) * plotHeight;
      const webhookHeight = (day.webhook_count / max) * plotHeight;
      const emailHeight = (day.email_count / max) * plotHeight;

      const apiY = PLOT_Y1 - apiHeight;
      const mcpY = apiY - mcpHeight;
      const uiY = mcpY - uiHeight;
      const webhookY = uiY - webhookHeight;
      const emailY = webhookY - emailHeight;

      const shortLabel = formatShortDate(day.date);
      const showLabel = index % 5 === 0 || index === days.length - 1;
      const tooltip = `${formatFullDate(day.date)}\nAPI: ${day.api_count}\nMCP: ${day.mcp_count}\nDashboard: ${day.ui_count}\nWebhook: ${day.webhook_count}\nEmail: ${day.email_count}`;

      return {
        date: day.date,
        shortLabel,
        showLabel,
        api: { y: apiY, height: apiHeight },
        mcp: { y: mcpY, height: mcpHeight },
        ui: { y: uiY, height: uiHeight },
        webhook: { y: webhookY, height: webhookHeight },
        email: { y: emailY, height: emailHeight },
        x,
        tooltip,
      };
    });
  });

  readonly barWidth = computed(() => (PLOT_X1 - PLOT_X0) / this.days().length - BAR_GAP);
  readonly baselineY = PLOT_Y1;
  readonly labelY = PLOT_Y1 + 18;

  /** Dados reais (não a altura em pixels) para a tabela `.sr-only` equivalente ao gráfico. */
  readonly tableRows = computed(() =>
    this.days().map((day) => ({
      date: formatFullDate(day.date),
      api: day.api_count,
      mcp: day.mcp_count,
      ui: day.ui_count,
      webhook: day.webhook_count,
      email: day.email_count,
      total: day.total_count,
    })),
  );
}

function formatShortDate(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${day}/${month}`;
}

function formatFullDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}
