import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type StatusTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

/**
 * Selo de estado funcional (ativa, em análise, encerrada, falhou).
 *
 * As cores aqui sao as unicas do produto que nao seguem a paleta navy/dourado: elas
 * carregam significado (verde = ok, ambar = atencao, vermelho = erro, azul = em
 * andamento, cinza = neutro/encerrado) e por isso nao mudam com o tema nem com a
 * marca. Nunca use este componente so pra colorir uma tag decorativa: pra isso
 * existe a classe global `.chip`.
 */
@Component({
  selector: 'app-status-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="status" [class]="'status--' + tone()"><ng-content /></span>`,
  styles: `
    :host {
      display: inline-flex;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: var(--radius-pill);
      font-size: 0.75rem;
      font-weight: 600;
      white-space: nowrap;
    }

    .status--success {
      background: rgba(34, 197, 94, 0.18);
      color: #15803d;
    }

    .status--info {
      background: rgba(56, 189, 248, 0.18);
      color: #0284c7;
    }

    .status--warning {
      background: rgba(234, 179, 8, 0.2);
      color: #a16207;
    }

    .status--danger {
      background: rgba(239, 68, 68, 0.18);
      color: #dc2626;
    }

    .status--neutral {
      background: rgba(100, 116, 139, 0.18);
      color: #475569;
    }

    /* No escuro o fundo translucido continua valendo, mas o texto precisa clarear
       pra manter contraste sobre a superficie escura. */
    :host-context(:root[data-theme='dark']) .status--success,
    :host-context(:root[data-theme='dark']) .status--info,
    :host-context(:root[data-theme='dark']) .status--warning,
    :host-context(:root[data-theme='dark']) .status--danger,
    :host-context(:root[data-theme='dark']) .status--neutral {
      color: #f1f5f9;
    }

    @media (prefers-color-scheme: dark) {
      :host-context(:root:not([data-theme='light'])) .status {
        color: #f1f5f9;
      }
    }
  `,
})
export class StatusBadge {
  readonly tone = input<StatusTone>('neutral');
}
