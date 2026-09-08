import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Cabecalho de pagina/secao: titulo (com subtitulo opcional) a esquerda, acoes a
 * direita. Mantem uma altura minima mesmo sem acao projetada, para o conteudo
 * abaixo nao pular quando o botao aparece.
 *
 * ```html
 * <app-page-header title="Licitações salvas" subtitle="12 filtros ativos">
 *   <button class="btn btn-primary btn-sm">Novo filtro</button>
 * </app-page-header>
 * ```
 */
@Component({
  selector: 'app-page-header',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div class="page-header__title-group">
        <h2 class="page-header__title">{{ title() }}</h2>
        @if (subtitle()) {
          <p class="page-header__subtitle">{{ subtitle() }}</p>
        }
      </div>
      <div class="page-header__actions">
        <ng-content />
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 44px;
    }

    .page-header__title-group {
      min-width: 0;
    }

    .page-header__title {
      font-size: 1.25rem;
      font-weight: 700;
    }

    .page-header__subtitle {
      margin-top: 4px;
      font-size: 0.85rem;
      color: var(--text-muted);
    }

    .page-header__actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
      flex-wrap: wrap;
    }

    @media (max-width: 640px) {
      .page-header {
        flex-direction: column;
        align-items: flex-start;
      }
    }
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input('');
}
