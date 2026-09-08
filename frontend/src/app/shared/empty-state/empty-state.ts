import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Estado vazio padrao: diz o que aconteceu e o que fazer a seguir. Um estado vazio
 * sem saida ("Nenhum resultado.") e um beco sem saida; por isso a dica e o slot de
 * acao fazem parte do componente.
 *
 * ```html
 * <app-empty-state
 *   title="Nenhuma licitação encontrada"
 *   hint="Tente ampliar o período ou remover a faixa de valor."
 * >
 *   <button class="btn btn-outline btn-sm" (click)="resetFilters()">Limpar filtros</button>
 * </app-empty-state>
 * ```
 */
@Component({
  selector: 'app-empty-state',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="empty-state">
      <p class="empty-state-title">{{ title() }}</p>
      @if (hint()) {
        <p class="empty-state-hint">{{ hint() }}</p>
      }
      <div class="empty-state__action">
        <ng-content />
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .empty-state__action {
      display: flex;
      justify-content: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .empty-state__action:not(:empty) {
      margin-top: 14px;
    }
  `,
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly hint = input('');
}
