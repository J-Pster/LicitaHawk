import { ChangeDetectionStrategy, Component, forwardRef, input, output, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

let nextSelectId = 0;

export interface SelectFieldOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * Select de escolha unica, com o mesmo chrome do `app-text-field` (rotulo, dica,
 * erro). Para escolha multipla use `app-multi-select`, nunca `<select multiple>`.
 *
 * Continua um `<select>` nativo por dentro de proposito: teclado, busca por
 * digitacao e o seletor em roda do mobile vem de graca e sao melhores que
 * qualquer reimplementacao.
 */
@Component({
  selector: 'app-select-field',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => SelectField),
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

      <div class="field__control field__control--select" [class.field__control--error]="!!error()">
        <select
          class="form-input field__input"
          [id]="fieldId"
          [value]="value()"
          [disabled]="isDisabled()"
          [required]="required()"
          [attr.aria-invalid]="!!error()"
          [attr.aria-describedby]="describedBy()"
          (change)="onSelect($event)"
          (blur)="onBlur()"
        >
          @if (placeholder()) {
            <option value="" [disabled]="required()">{{ placeholder() }}</option>
          }
          @for (option of options(); track option.value) {
            <option [value]="option.value" [disabled]="option.disabled ?? false">
              {{ option.label }}
            </option>
          }
        </select>

        <svg class="field__chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
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
export class SelectField implements ControlValueAccessor {
  readonly label = input('');
  readonly options = input.required<readonly SelectFieldOption[]>();
  /** Primeira opcao, vazia. Deixe em branco para nao ter opcao neutra. */
  readonly placeholder = input('');
  readonly hint = input('');
  readonly error = input('');
  readonly required = input(false);

  readonly valueChange = output<string>();

  protected readonly fieldId = `select-${nextSelectId++}`;
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

  protected onSelect(event: Event): void {
    const next = (event.target as HTMLSelectElement).value;
    this.value.set(next);
    this.onChange(next);
    this.valueChange.emit(next);
  }

  protected onBlur(): void {
    this.onTouched();
  }

  writeValue(value: string | null): void {
    this.value.set(value ?? '');
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
