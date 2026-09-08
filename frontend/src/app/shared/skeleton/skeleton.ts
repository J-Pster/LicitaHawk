import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Placeholder de carregamento. Use no lugar de "Carregando..." sempre que der pra
 * antecipar o formato do conteudo: a tela nao muda de altura quando os dados
 * chegam, e a espera parece menor.
 *
 * - `variant="table"`: N linhas com M colunas, para `data-table`.
 * - `variant="lines"`: N barras empilhadas, para blocos de texto.
 * - `variant="card"`: bloco unico com altura livre.
 *
 * A animacao respeita `prefers-reduced-motion` (regra global em styles.scss).
 */
@Component({
  selector: 'app-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="skeleton" role="status" aria-live="polite" [attr.aria-label]="ariaLabel()">
      @switch (variant()) {
        @case ('table') {
          @for (row of rowRange(); track row) {
            <div class="skeleton__row">
              @for (col of columnRange(); track col) {
                <span class="skeleton-block" [style.flex]="col === 0 ? 2 : 1"></span>
              }
            </div>
          }
        }
        @case ('card') {
          <span class="skeleton-block skeleton__card" [style.height.px]="height()"></span>
        }
        @default {
          @for (row of rowRange(); track row) {
            <span class="skeleton-block" [style.width.%]="row === rows() - 1 ? 60 : 100"></span>
          }
        }
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .skeleton {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .skeleton__row {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 14px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--panel-muted);
    }

    .skeleton__card {
      height: 120px;
      border-radius: var(--radius-md);
    }
  `,
})
export class Skeleton {
  readonly variant = input<'lines' | 'table' | 'card'>('lines');
  readonly rows = input(3);
  readonly columns = input(4);
  /** Altura em px da variante `card`. */
  readonly height = input(120);
  readonly ariaLabel = input('Carregando');

  protected readonly rowRange = computed(() => range(this.rows()));
  protected readonly columnRange = computed(() => range(this.columns()));
}

function range(size: number): readonly number[] {
  return Array.from({ length: Math.max(0, size) }, (_, i) => i);
}
