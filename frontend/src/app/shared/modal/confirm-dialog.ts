import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { ModalShell } from './modal-shell';

/**
 * Confirmacao padrao do produto ("tem certeza?"). Toda acao destrutiva ou
 * irreversivel passa por aqui, para largura, espacamento e tratamento dos botoes
 * ficarem iguais em todas as telas.
 *
 * O consumidor cria/destroi com `@if`, igual ao `app-modal-shell`:
 *
 * ```html
 * @if (keyToRevoke(); as key) {
 *   <app-confirm-dialog
 *     title="Revogar API key"
 *     confirmLabel="Revogar"
 *     busyLabel="Revogando..."
 *     [busy]="revoking()"
 *     (confirmed)="revoke(key)"
 *     (cancelled)="keyToRevoke.set(null)"
 *   >
 *     <p>A chave <strong>{{ key.prefix }}</strong> para de funcionar na hora. Nao da pra desfazer.</p>
 *   </app-confirm-dialog>
 * }
 * ```
 *
 * O corpo vem de `message` (texto simples) ou de conteudo projetado (markup rico).
 */
@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ModalShell],
  template: `
    <app-modal-shell
      [title]="title"
      size="sm"
      [dismissible]="!busy"
      (closed)="onCancel()"
    >
      @if (message) {
        <p class="confirm__message">{{ message }}</p>
      }
      <ng-content />

      <div modalFooter>
        <button type="button" class="btn btn-outline" [disabled]="busy" (click)="onCancel()">
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          class="btn"
          [class.btn-danger]="confirmVariant === 'danger'"
          [class.btn-primary]="confirmVariant === 'primary'"
          [disabled]="busy || confirmDisabled"
          (click)="onConfirm()"
        >
          {{ busy ? busyLabel : confirmLabel }}
        </button>
      </div>
    </app-modal-shell>
  `,
  styles: `
    :host {
      display: contents;
    }

    .confirm__message {
      color: var(--text);
      font-size: 0.95rem;
    }
  `,
})
export class ConfirmDialog {
  @Input() title = '';

  /** Corpo em texto simples. Para markup rico, projete conteudo. */
  @Input() message = '';

  @Input() confirmLabel = 'Confirmar';
  @Input() cancelLabel = 'Cancelar';

  /** Rotulo do botao de confirmar enquanto `busy` for true. */
  @Input() busyLabel = 'Processando...';

  /** Trava os dois botoes e impede o dispensar enquanto a acao roda. */
  @Input() busy = false;

  /** Desabilita so o confirmar (pre-condicao nao atendida), sem entrar em busy. */
  @Input() confirmDisabled = false;

  /** `danger` = vermelho solido (destrutivo). `primary` = dourado padrao. */
  @Input() confirmVariant: 'danger' | 'primary' = 'danger';

  @Output() readonly confirmed = new EventEmitter<void>();
  @Output() readonly cancelled = new EventEmitter<void>();

  onConfirm(): void {
    if (this.busy || this.confirmDisabled) {
      return;
    }
    this.confirmed.emit();
  }

  onCancel(): void {
    if (this.busy) {
      return;
    }
    this.cancelled.emit();
  }
}
