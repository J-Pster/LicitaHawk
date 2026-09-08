import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DropdownPopover } from './dropdown-popover';

export interface MultiSelectOption {
  readonly value: string;
  readonly label: string;
  /** Linha secundaria discreta (ex.: o nome por extenso de uma sigla). */
  readonly hint?: string;
}

/**
 * Selecao multipla em dropdown, no lugar do `<select multiple>` nativo (que e feio,
 * inconsistente entre navegadores e ruim de usar com muitas opcoes).
 *
 * A selecao pertence ao consumidor: o componente recebe `selected` e emite
 * `selectionChange` com o array novo, nunca muta o de entrada.
 *
 * ```html
 * <app-multi-select
 *   [options]="ufOptions"
 *   [selected]="selectedUfs()"
 *   singularLabel="UF"
 *   pluralLabel="UFs"
 *   (selectionChange)="selectedUfs.set($event)"
 * />
 * ```
 */
@Component({
  selector: 'app-multi-select',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DropdownPopover],
  template: `
    <button
      #trigger
      type="button"
      class="ms__trigger"
      [class.ms__trigger--open]="isOpen()"
      [disabled]="disabled()"
      [attr.aria-expanded]="isOpen()"
      aria-haspopup="listbox"
      (click)="toggle()"
    >
      <span class="ms__label">{{ displayText() }}</span>
      <svg class="ms__chevron" [class.ms__chevron--open]="isOpen()" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>

    <app-dropdown-popover
      [open]="isOpen()"
      [trigger]="trigger"
      [matchTriggerWidth]="true"
      [minWidth]="240"
      [maxHeight]="360"
      (dismissed)="close()"
    >
      @if (searchable()) {
        <div class="ms__search">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            class="ms__search-input"
            [placeholder]="searchPlaceholder()"
            [value]="query()"
            (input)="onQuery($event)"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
      }

      <div class="ms__actions">
        <button type="button" class="btn-link" (click)="selectAll()">Selecionar tudo</button>
        <span class="ms__actions-sep">|</span>
        <button type="button" class="btn-link" (click)="clearAll()">Limpar</button>
      </div>

      <div class="ms__list" role="listbox" aria-multiselectable="true">
        @for (option of filteredOptions(); track option.value) {
          <button
            type="button"
            class="menu-item"
            role="option"
            [attr.aria-selected]="isSelected(option.value)"
            (click)="toggleOption(option.value)"
          >
            <span class="ms__check" [class.ms__check--on]="isSelected(option.value)" aria-hidden="true">
              @if (isSelected(option.value)) {
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              }
            </span>
            <span class="ms__option-text">
              {{ option.label }}
              @if (option.hint) {
                <span class="ms__option-hint">{{ option.hint }}</span>
              }
            </span>
          </button>
        } @empty {
          <p class="ms__empty">Nenhuma opção encontrada.</p>
        }
      </div>
    </app-dropdown-popover>
  `,
  styleUrl: './multi-select.scss',
})
export class MultiSelect {
  readonly options = input.required<readonly MultiSelectOption[]>();
  readonly selected = input<readonly string[]>([]);
  readonly disabled = input(false);

  /** Texto do gatilho quando nada esta selecionado. */
  readonly placeholder = input('Selecionar');
  readonly singularLabel = input('item');
  readonly pluralLabel = input('itens');

  /** Campo de busca dentro do painel. Padrao: liga sozinho a partir de 8 opcoes. */
  readonly searchable = input(true);
  readonly searchPlaceholder = input('Filtrar...');

  readonly selectionChange = output<string[]>();

  protected readonly isOpen = signal(false);
  protected readonly query = signal('');

  private readonly selectedSet = computed(() => new Set(this.selected()));

  protected readonly filteredOptions = computed(() => {
    const term = this.query().trim().toLowerCase();
    if (!term) {
      return this.options();
    }
    return this.options().filter(
      (option) =>
        option.label.toLowerCase().includes(term) || option.value.toLowerCase().includes(term),
    );
  });

  protected readonly displayText = computed(() => {
    const count = this.selected().length;
    if (count === 0) {
      return this.placeholder();
    }
    if (count === this.options().length) {
      return `Todos (${count})`;
    }
    if (count === 1) {
      const only = this.options().find((option) => option.value === this.selected()[0]);
      return only?.label ?? `1 ${this.singularLabel()}`;
    }
    return `${count} ${this.pluralLabel()}`;
  });

  protected isSelected(value: string): boolean {
    return this.selectedSet().has(value);
  }

  protected toggle(): void {
    if (this.disabled()) {
      return;
    }
    this.isOpen.update((open) => !open);
  }

  protected close(): void {
    this.isOpen.set(false);
    this.query.set('');
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected toggleOption(value: string): void {
    const next = new Set(this.selectedSet());
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    this.selectionChange.emit([...next]);
  }

  protected selectAll(): void {
    this.selectionChange.emit(this.filteredOptions().map((option) => option.value));
  }

  protected clearAll(): void {
    this.selectionChange.emit([]);
  }
}
