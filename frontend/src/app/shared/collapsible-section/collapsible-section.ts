import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

let nextCollapsibleId = 0;

/**
 * Secao expansivel com cabecalho acessivel (`aria-expanded` + `aria-controls`).
 *
 * `open` e um `model`, entao o estado pertence ao pai: quem quiser persistir a
 * preferencia persiste, o componente nunca fala com storage. Fechado, o painel sai
 * do DOM em vez de ficar escondido, o que mantem barato empilhar muitas secoes.
 */
@Component({
  selector: 'app-collapsible-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="collapsible" [class.collapsible--open]="open()">
      <h3 class="collapsible__heading">
        <button
          type="button"
          class="collapsible__trigger"
          [id]="headerId"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="panelId"
          (click)="toggle()"
        >
          <span class="collapsible__title">{{ heading() }}</span>
          @if (meta()) {
            <span class="collapsible__meta">{{ meta() }}</span>
          }
          <svg class="collapsible__chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </h3>

      @if (open()) {
        <div class="collapsible__panel" [id]="panelId" role="region" [attr.aria-labelledby]="headerId">
          <ng-content />
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
    }

    .collapsible {
      background: var(--surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      overflow: hidden;
    }

    .collapsible__heading {
      margin: 0;
      font-size: inherit;
      font-weight: inherit;
    }

    .collapsible__trigger {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 12px 16px;
      border: none;
      background: transparent;
      color: var(--text);
      font-family: var(--font-body);
      text-align: left;
      cursor: pointer;
      transition: background var(--transition-fast);
    }

    .collapsible__trigger:hover {
      background: var(--hover-bg);
    }

    .collapsible__trigger:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }

    .collapsible__title {
      flex: 1;
      min-width: 0;
      font-size: 0.9rem;
      font-weight: 600;
      line-height: 1.4;
    }

    .collapsible__meta {
      font-size: 0.78rem;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .collapsible__chevron {
      flex-shrink: 0;
      color: var(--text-fine);
      transition: transform var(--transition-fast);
    }

    .collapsible--open .collapsible__chevron {
      transform: rotate(180deg);
    }

    .collapsible__panel {
      padding: 16px;
      border-top: 1px solid var(--color-border);
    }
  `,
})
export class CollapsibleSection {
  readonly heading = input.required<string>();
  /** Texto discreto a direita do titulo (contagem, status). */
  readonly meta = input('');
  readonly open = model(false);

  private readonly uid = nextCollapsibleId++;
  protected readonly headerId = `collapsible-header-${this.uid}`;
  protected readonly panelId = `collapsible-panel-${this.uid}`;

  protected toggle(): void {
    this.open.update((value) => !value);
  }
}
