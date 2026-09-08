import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  signal,
} from '@angular/core';

/**
 * Painel flutuante ancorado a um elemento gatilho (menu, lista de opcoes, seletor).
 *
 * Posicionamento em CSS/JS puro, sem @angular/cdk: `position: fixed` calculado a
 * partir do `getBoundingClientRect()` do gatilho, com flip vertical (abre pra cima
 * quando nao cabe embaixo) e clamp horizontal pra nunca vazar da viewport. E o
 * mesmo raciocinio do Overlay do CDK (flexibleConnectedTo + withPush), feito a mao
 * pra nao puxar uma dependencia nova. Mesma tecnica ja usada em `app-help-tooltip`.
 *
 * O estado aberto/fechado pertence ao consumidor: este componente so avisa quando
 * o usuario pediu pra fechar (clique fora ou Escape), via `(dismissed)`.
 *
 * ```html
 * <button #trigger (click)="open.set(!open())">Filtros</button>
 * <app-dropdown-popover
 *   [open]="open()"
 *   [trigger]="trigger"
 *   [matchTriggerWidth]="true"
 *   (dismissed)="open.set(false)"
 * >
 *   <button class="menu-item">Uma opcao</button>
 * </app-dropdown-popover>
 * ```
 */
@Component({
  selector: 'app-dropdown-popover',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open) {
      <div
        #panel
        class="popover menu-panel"
        [class.popover--above]="placeAbove()"
        [style.top.px]="top()"
        [style.left.px]="left()"
        [style.min-width.px]="resolvedMinWidth()"
        [style.max-width.px]="maxWidth"
        [style.max-height.px]="maxHeight"
      >
        <ng-content />
      </div>
    }
  `,
  styleUrl: './dropdown-popover.scss',
})
export class DropdownPopover implements OnChanges, OnDestroy {
  /** Quem manda no aberto/fechado e o consumidor. */
  @Input({ required: true }) open = false;

  /** Elemento ancora. Use uma referencia de template (`#trigger`). */
  @Input({ required: true }) trigger!: HTMLElement;

  /** Painel com a largura exata do gatilho (padrao de campo de busca/select). */
  @Input() matchTriggerWidth = false;

  /** Largura minima quando `matchTriggerWidth` for false. */
  @Input() minWidth = 200;

  @Input() maxWidth = 420;

  @Input() maxHeight = 320;

  /** `start` alinha pela borda esquerda do gatilho, `end` pela direita. */
  @Input() align: 'start' | 'end' = 'start';

  @Output() readonly dismissed = new EventEmitter<void>();

  @ViewChild('panel') private panelRef?: ElementRef<HTMLElement>;

  protected readonly top = signal(0);
  protected readonly left = signal(0);
  protected readonly placeAbove = signal(false);
  protected readonly triggerWidth = signal(0);

  private listening = false;
  private frame: number | null = null;

  protected resolvedMinWidth(): number {
    return this.matchTriggerWidth ? this.triggerWidth() : this.minWidth;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['open'] && !changes['trigger']) {
      return;
    }
    if (this.open && this.trigger) {
      this.reposition();
      // Segunda medida depois do paint: agora o painel existe e tem altura real,
      // entao o flip usa a altura de verdade em vez da estimativa.
      this.frame = requestAnimationFrame(() => this.reposition());
      this.startListening();
      return;
    }
    this.stopListening();
  }

  ngOnDestroy(): void {
    this.stopListening();
  }

  /** Reposiciona (nao fecha) quando a pagina rola: o painel acompanha o gatilho. */
  private readonly onScroll = (): void => {
    if (this.open) {
      this.reposition();
    }
  };

  private readonly onResize = (): void => {
    if (this.open) {
      this.reposition();
    }
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (!target) {
      return;
    }
    const insidePanel = this.panelRef?.nativeElement.contains(target) ?? false;
    const insideTrigger = this.trigger?.contains(target) ?? false;
    if (!insidePanel && !insideTrigger) {
      this.dismissed.emit();
    }
  };

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.dismissed.emit();
    }
  };

  private startListening(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('keydown', this.onKeydown, true);
    window.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.onResize);
  }

  private stopListening(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    if (!this.listening) {
      return;
    }
    this.listening = false;
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('keydown', this.onKeydown, true);
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onResize);
  }

  private reposition(): void {
    if (!this.trigger) {
      return;
    }
    const rect = this.trigger.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    this.triggerWidth.set(rect.width);

    const panelEl = this.panelRef?.nativeElement;
    const panelH = panelEl?.offsetHeight || Math.min(this.maxHeight, 240);
    const panelW = panelEl?.offsetWidth || this.resolvedMinWidth();

    const spaceBelow = viewportH - rect.bottom;
    const spaceAbove = rect.top;
    const above = spaceBelow < panelH + gap + margin && spaceAbove > spaceBelow;
    this.placeAbove.set(above);
    this.top.set(above ? Math.max(margin, rect.top - gap - panelH) : rect.bottom + gap);

    const rawLeft = this.align === 'end' ? rect.right - panelW : rect.left;
    this.left.set(Math.max(margin, Math.min(rawLeft, viewportW - panelW - margin)));
  }
}
