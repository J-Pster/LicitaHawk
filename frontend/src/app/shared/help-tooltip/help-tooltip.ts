import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Input,
  OnDestroy,
  ViewChild,
  signal,
} from '@angular/core';

/**
 * Ajuda global: um circulo "?" pequeno que revela um painel posicionado ao passar o mouse/focar.
 * Passe texto simples via [text], ou projete HTML rico via <ng-content>.
 *
 *   <app-help-tooltip text="Filtra por um termo dentro da descricao." />
 *   <app-help-tooltip ariaLabel="Ajuda sobre X">
 *     <strong>Exemplo:</strong> texto rico aqui.
 *   </app-help-tooltip>
 *
 * Posicionamento em CSS puro (sem @angular/cdk): o painel usa `position: fixed` calculado via
 * getBoundingClientRect do trigger, com flip vertical (acima/abaixo) e clamp horizontal pra nunca
 * vazar da viewport -- mesmo raciocinio do Overlay do CDK (flexibleConnectedTo + withPush), so que
 * calculado a mao, evitando puxar uma dependencia nova pro projeto so por causa deste componente.
 */
@Component({
  selector: 'app-help-tooltip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="help-tooltip">
      <button
        #trigger
        type="button"
        class="help-tooltip__icon"
        [attr.aria-label]="ariaLabel || 'Mais informações'"
        (mouseenter)="open()"
        (mouseleave)="scheduleClose()"
        (focus)="open()"
        (blur)="scheduleClose()"
      >
        <svg class="help-tooltip__svg" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <circle cx="10" cy="10" r="9" />
          <text x="10" y="14" text-anchor="middle">?</text>
        </svg>
      </button>

      @if (visible()) {
        <div
          class="help-tooltip__panel"
          role="tooltip"
          [style.top.px]="placeAbove() ? null : top()"
          [style.bottom.px]="placeAbove() ? bottom() : null"
          [style.left.px]="left()"
          [style.width.px]="panelWidth"
          (mouseenter)="cancelClose()"
          (mouseleave)="scheduleClose()"
        >
          @if (text) {
            <p class="help-tooltip__text">{{ text }}</p>
          } @else {
            <ng-content></ng-content>
          }
        </div>
      }
    </span>
  `,
  styleUrl: './help-tooltip.scss',
})
export class HelpTooltip implements OnDestroy {
  /** Corpo em texto simples. Quando omitido, exibe o conteudo projetado (<ng-content>). */
  @Input() text?: string;
  /** Rotulo acessivel do trigger. */
  @Input() ariaLabel?: string;
  /** Largura do painel em px. */
  @Input() panelWidth = 260;

  @ViewChild('trigger', { static: true }) private readonly triggerRef!: ElementRef<HTMLButtonElement>;

  readonly visible = signal(false);
  readonly top = signal(0);
  readonly bottom = signal(0);
  readonly left = signal(0);
  readonly placeAbove = signal(false);

  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnDestroy(): void {
    this.clearTimer();
  }

  open(): void {
    this.clearTimer();
    this.reposition();
    this.visible.set(true);
  }

  /** Fecha depois de um pequeno delay, pra dar tempo do ponteiro viajar ate o painel. */
  scheduleClose(): void {
    this.clearTimer();
    this.closeTimer = setTimeout(() => this.close(), 150);
  }

  cancelClose(): void {
    this.clearTimer();
  }

  close(): void {
    this.clearTimer();
    this.visible.set(false);
  }

  @HostListener('window:resize')
  onViewportResize(): void {
    if (this.visible()) {
      this.reposition();
    }
  }

  private reposition(): void {
    const rect = this.triggerRef.nativeElement.getBoundingClientRect();
    const margin = 8;
    const gap = 8;
    const estimatedPanelHeight = 130;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;
    const placeAbove = spaceBelow < estimatedPanelHeight + gap && spaceAbove > spaceBelow;
    this.placeAbove.set(placeAbove);

    let left = rect.left + rect.width / 2 - this.panelWidth / 2;
    left = Math.max(margin, Math.min(left, vw - this.panelWidth - margin));
    this.left.set(left);

    if (placeAbove) {
      this.bottom.set(vh - rect.top + gap);
    } else {
      this.top.set(rect.bottom + gap);
    }
  }

  private clearTimer(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }
}
