import { ChangeDetectionStrategy, Component, forwardRef, input, output, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

let nextFieldId = 0;

/**
 * Campo de texto padrao: rotulo, controle, dica e erro, sempre na mesma ordem e
 * com os mesmos espacamentos. Evita que cada tela remonte `.form-group` na mao e
 * esqueca metade dos detalhes (`for`/`id`, `aria-describedby`, estado de erro).
 *
 * Implementa `ControlValueAccessor`, entao funciona com `[(ngModel)]` e com
 * reactive forms sem nenhuma ponte extra.
 *
 * ```html
 * <app-text-field
 *   label="Palavra-chave"
 *   placeholder="ex.: merenda escolar"
 *   hint="Filtra dentro da pagina de resultados ja carregada."
 *   [(ngModel)]="keyword"
 *   name="keyword"
 * />
 * ```
 */
@Component({
  selector: 'app-text-field',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => TextField),
      multi: true,
    },
  ],
  template: `
    <div class="field">
      @if (label()) {
        <label class="form-label" [for]="fieldId">
          {{ label() }}
          @if (required()) {
            <span class="field__required" aria-hidden="true">*</span>
          }
        </label>
      }

      <div class="field__control" [class.field__control--error]="!!error()">
        <input
          class="form-input field__input"
          [id]="fieldId"
          [type]="type()"
          [placeholder]="placeholder()"
          [value]="value()"
          [disabled]="isDisabled()"
          [required]="required()"
          [attr.inputmode]="inputMode() || null"
          [attr.min]="min() ?? null"
          [attr.max]="max() ?? null"
          [attr.step]="step() ?? null"
          [attr.autocomplete]="autocomplete() || null"
          [attr.aria-invalid]="!!error()"
          [attr.aria-describedby]="describedBy()"
          (input)="onInput($event)"
          (blur)="onBlur()"
          (keyup.enter)="submitted.emit()"
        />

        @if (clearable() && value() && !isDisabled()) {
          <button
            type="button"
            class="icon-btn icon-btn--sm field__clear"
            (click)="clear()"
            aria-label="Limpar campo"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        }
      </div>

      @if (error()) {
        <p class="form-error" [id]="fieldId + '-error'">{{ error() }}</p>
      } @else if (hint()) {
        <p class="form-hint" [id]="fieldId + '-hint'">{{ hint() }}</p>
      }
    </div>
  `,
  styleUrl: './fields.scss',
})
export class TextField implements ControlValueAccessor {
  readonly label = input('');
  readonly type = input<'text' | 'email' | 'password' | 'number' | 'date' | 'tel' | 'url'>('text');
  readonly placeholder = input('');
  readonly hint = input('');
  /** Mensagem de erro. Preenchida, ela substitui a dica e marca o campo. */
  readonly error = input('');
  readonly required = input(false);
  readonly clearable = input(false);
  readonly inputMode = input('');
  readonly autocomplete = input('');
  readonly min = input<number | string | null>(null);
  readonly max = input<number | string | null>(null);
  readonly step = input<number | string | null>(null);

  /** Enter dentro do campo (busca rapida sem botao). */
  readonly submitted = output<void>();
  readonly valueChange = output<string>();

  protected readonly fieldId = `field-${nextFieldId++}`;
  protected readonly value = signal('');
  protected readonly isDisabled = signal(false);

  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};

  protected describedBy(): string | null {
    if (this.error()) {
      return `${this.fieldId}-error`;
    }
    return this.hint() ? `${this.fieldId}-hint` : null;
  }

  protected onInput(event: Event): void {
    const next = (event.target as HTMLInputElement).value;
    this.value.set(next);
    this.onChange(next);
    this.valueChange.emit(next);
  }

  protected onBlur(): void {
    this.onTouched();
  }

  protected clear(): void {
    this.value.set('');
    this.onChange('');
    this.valueChange.emit('');
  }

  writeValue(value: string | number | null): void {
    this.value.set(value === null || value === undefined ? '' : String(value));
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.isDisabled.set(isDisabled);
  }
}
