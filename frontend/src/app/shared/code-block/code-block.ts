import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, inject, input } from '@angular/core';
import { ToastService } from '../../core/toast.service';

/**
 * Bloco de código: rótulo na barra superior, botão copiar com retorno via `ToastService` e
 * rolagem horizontal própria no `<pre>` (nunca estica a página, mesmo com uma linha longa de curl
 * ou um JSON de exemplo).
 *
 * Duas formas de preencher o conteúdo:
 *
 * ```html
 * <!-- string simples, o caso comum -->
 * <app-code-block label="Exemplo" [code]="curlExample" />
 *
 * <!-- conteúdo projetado, quando o texto já é montado no template do chamador -->
 * <app-code-block label="Configuração">{{ jsonConfig() }}</app-code-block>
 * ```
 *
 * O botão copiar usa `code()` quando informado; sem ele, copia o texto renderizado do conteúdo
 * projetado.
 */
@Component({
  selector: 'app-code-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="code-block">
      <div class="code-block__toolbar">
        <span class="code-block__label">{{ label() }}</span>
        <button type="button" class="icon-btn icon-btn--sm" aria-label="Copiar" (click)="copy()">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
      </div>
      <pre class="code-block__pre"><code #codeEl>@if (code(); as c) {{{ c }}} @else {<ng-content /> }</code></pre>
    </div>
  `,
  styleUrl: './code-block.scss',
})
export class CodeBlock {
  private readonly toastService = inject(ToastService);

  /** Rótulo curto na barra superior (ex.: "Exemplo de chamada"). */
  readonly label = input('Exemplo');
  /** Texto a exibir/copiar. Quando omitido, usa o conteúdo projetado via `<ng-content>`. */
  readonly code = input<string>();

  @ViewChild('codeEl', { static: true }) private readonly codeEl!: ElementRef<HTMLElement>;

  async copy(): Promise<void> {
    const text = this.code() ?? this.codeEl.nativeElement.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      this.toastService.success('Copiado para a área de transferência');
    } catch {
      this.toastService.error('Não foi possível copiar');
    }
  }
}
