import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { DropdownPopover } from '../dropdown/dropdown-popover';

export interface SearchOption {
  readonly value: string;
  readonly label: string;
  /** Linha secundaria (endereco, orgao, CNPJ...). */
  readonly hint?: string;
}

/**
 * Campo de busca com sugestoes: o usuario digita, o componente consulta e ele
 * escolhe um item da lista. Serve tanto pra lista local quanto pra busca remota.
 *
 * - Lista local: passe `options`. O filtro roda em memoria, sem debounce.
 * - Busca remota: passe `searchFn`. Ela recebe o termo ja com debounce e minimo de
 *   caracteres aplicados, e devolve as opcoes. Resultado de chamada antiga que
 *   chega atrasada e descartado (guarda de sequencia), entao a lista nunca "volta"
 *   pra um termo que o usuario ja abandonou.
 *
 * Teclado: setas navegam, Enter escolhe, Escape fecha.
 *
 * ```html
 * <app-search-select
 *   placeholder="Buscar orgao por nome ou CNPJ"
 *   [searchFn]="buscarOrgaos"
 *   (selectedChange)="orgao.set($event)"
 * />
 * ```
 */
@Component({
  selector: 'app-search-select',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DropdownPopover],
  template: `
    <div #field class="ss__field" [class.ss__field--open]="isOpen()">
      <svg class="ss__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>

      <input
        #input
        type="text"
        class="ss__input"
        role="combobox"
        aria-autocomplete="list"
        [attr.aria-expanded]="isOpen()"
        [placeholder]="placeholder()"
        [value]="text()"
        [disabled]="disabled()"
        (input)="onInput($event)"
        (focus)="onFocus()"
        (keydown)="onKeydown($event)"
        autocomplete="off"
        spellcheck="false"
      />

      @if (loading()) {
        <span class="spinner ss__spinner" aria-label="Buscando"></span>
      } @else if (text()) {
        <button type="button" class="icon-btn icon-btn--sm ss__clear" (click)="clear()" aria-label="Limpar busca">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      }
    </div>

    <app-dropdown-popover
      [open]="isOpen()"
      [trigger]="fieldEl()"
      [matchTriggerWidth]="true"
      [maxWidth]="720"
      [maxHeight]="340"
      (dismissed)="close()"
    >
      @if (loading()) {
        <p class="ss__status">Buscando...</p>
      } @else if (results().length > 0) {
        <div class="ss__list" role="listbox">
          @for (option of results(); track option.value; let i = $index) {
            <button
              type="button"
              class="menu-item"
              role="option"
              [class.is-active]="i === activeIndex()"
              [attr.aria-selected]="i === activeIndex()"
              (mouseenter)="activeIndex.set(i)"
              (click)="choose(option)"
            >
              <span class="ss__option">
                <span class="ss__option-label">{{ option.label }}</span>
                @if (option.hint) {
                  <span class="ss__option-hint">{{ option.hint }}</span>
                }
              </span>
            </button>
          }
        </div>
      } @else if (searched()) {
        <div class="ss__status ss__status--empty">
          <p>Nada encontrado para "{{ term() }}".</p>
          @if (createLabel()) {
            <button type="button" class="btn btn-outline btn-xs" (click)="requestCreate()">
              {{ createLabel() }}
            </button>
          }
        </div>
      } @else {
        <p class="ss__status">Digite ao menos {{ minChars() }} caracteres.</p>
      }
    </app-dropdown-popover>
  `,
  styleUrl: './search-select.scss',
})
export class SearchSelect implements OnDestroy {
  /** Lista local. Ignorada quando `searchFn` esta definida. */
  readonly options = input<readonly SearchOption[] | null>(null);

  /** Busca remota. Recebe o termo ja filtrado por debounce e minimo de caracteres. */
  readonly searchFn = input<((term: string) => Promise<readonly SearchOption[]>) | null>(null);

  readonly placeholder = input('Buscar...');
  readonly disabled = input(false);
  readonly minChars = input(2);
  readonly debounceMs = input(300);

  /** Quando preenchido, oferece uma acao no estado vazio (ex.: "Cadastrar novo"). */
  readonly createLabel = input('');

  readonly selectedChange = output<SearchOption>();
  readonly cleared = output<void>();
  readonly createRequested = output<string>();

  @ViewChild('field', { static: true }) private readonly fieldRef!: ElementRef<HTMLElement>;
  @ViewChild('input', { static: true }) private readonly inputRef!: ElementRef<HTMLInputElement>;

  protected readonly text = signal('');
  protected readonly term = signal('');
  protected readonly results = signal<readonly SearchOption[]>([]);
  protected readonly loading = signal(false);
  protected readonly searched = signal(false);
  protected readonly isOpen = signal(false);
  protected readonly activeIndex = signal(0);

  /** O painel ancora no campo inteiro, nao so no input. */
  protected readonly fieldEl = computed(() => this.fieldRef.nativeElement);

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private requestSeq = 0;

  ngOnDestroy(): void {
    this.clearTimer();
  }

  protected onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.text.set(value);
    this.activeIndex.set(0);

    const trimmed = value.trim();
    if (trimmed.length < this.minChars()) {
      this.clearTimer();
      this.results.set([]);
      this.searched.set(false);
      this.loading.set(false);
      this.term.set(trimmed);
      this.isOpen.set(trimmed.length > 0);
      return;
    }

    this.isOpen.set(true);
    const local = this.options();
    if (local && !this.searchFn()) {
      this.term.set(trimmed);
      this.results.set(filterLocally(local, trimmed));
      this.searched.set(true);
      return;
    }

    this.clearTimer();
    this.loading.set(true);
    this.debounceTimer = setTimeout(() => void this.runRemoteSearch(trimmed), this.debounceMs());
  }

  protected onFocus(): void {
    if (this.results().length > 0 || this.text().trim().length > 0) {
      this.isOpen.set(true);
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const total = this.results().length;
      if (total === 0) {
        return;
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this.isOpen.set(true);
      this.activeIndex.update((i) => (i + delta + total) % total);
      return;
    }

    if (event.key === 'Enter') {
      const option = this.results()[this.activeIndex()];
      if (this.isOpen() && option) {
        event.preventDefault();
        this.choose(option);
      }
      return;
    }

    if (event.key === 'Escape' && this.isOpen()) {
      event.preventDefault();
      this.close();
    }
  }

  protected choose(option: SearchOption): void {
    this.text.set(option.label);
    this.close();
    this.selectedChange.emit(option);
  }

  protected clear(): void {
    this.clearTimer();
    this.text.set('');
    this.term.set('');
    this.results.set([]);
    this.searched.set(false);
    this.loading.set(false);
    this.close();
    this.inputRef.nativeElement.focus();
    this.cleared.emit();
  }

  protected close(): void {
    this.isOpen.set(false);
  }

  protected requestCreate(): void {
    this.close();
    this.createRequested.emit(this.term());
  }

  /**
   * Guarda de sequencia: so a resposta da ultima busca disparada pinta a tela.
   * Sem isso, uma chamada lenta de um termo antigo chegando depois sobrescreveria
   * o resultado do termo atual.
   */
  private async runRemoteSearch(term: string): Promise<void> {
    const search = this.searchFn();
    if (!search) {
      this.loading.set(false);
      return;
    }
    const seq = ++this.requestSeq;
    this.term.set(term);
    try {
      const found = await search(term);
      if (seq !== this.requestSeq) {
        return;
      }
      this.results.set(found);
      this.searched.set(true);
    } catch {
      if (seq !== this.requestSeq) {
        return;
      }
      this.results.set([]);
      this.searched.set(true);
    } finally {
      if (seq === this.requestSeq) {
        this.loading.set(false);
      }
    }
  }

  private clearTimer(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

function filterLocally(options: readonly SearchOption[], term: string): readonly SearchOption[] {
  const needle = term.toLowerCase();
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      (option.hint?.toLowerCase().includes(needle) ?? false),
  );
}
