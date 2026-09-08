import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  ViewChild,
} from '@angular/core';

let openModalCount = 0;

/**
 * Casca estrutural de TODO modal do produto. Nenhuma tela monta overlay proprio.
 *
 * Invariante de layout: header fixo, corpo rolando sozinho, rodape fixo. O painel
 * nunca passa da altura da viewport, entao o rodape (onde ficam as acoes) esta
 * sempre visivel, independente do tamanho do conteudo.
 *
 * Usa o `<dialog>` nativo com `showModal()`, e nao um `position: fixed` com
 * z-index alto. Motivo: o dialog modal vai pro *top layer* do browser, acima de
 * qualquer stacking context da pagina -- um ancestral com `transform`/`filter`
 * (que prende `position: fixed`) nao consegue enterrar o modal atras da sidebar.
 * De brinde vem foco preso dentro do dialog, Escape e `::backdrop`, tudo nativo,
 * sem @angular/cdk no projeto.
 *
 * Uso: o consumidor cria e destroi o componente com `@if`, como no exemplo:
 *
 * ```html
 * @if (showEdit()) {
 *   <app-modal-shell title="Editar filtro" (closed)="showEdit.set(false)">
 *     <p>Conteudo...</p>
 *     <div modalFooter>
 *       <button class="btn btn-outline" (click)="showEdit.set(false)">Cancelar</button>
 *       <button class="btn btn-primary" (click)="save()">Salvar</button>
 *     </div>
 *   </app-modal-shell>
 * }
 * ```
 */
@Component({
  selector: 'app-modal-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="modal"
      [class.modal--sm]="size === 'sm'"
      [class.modal--lg]="size === 'lg'"
      [class.modal--full]="size === 'full'"
      [attr.aria-label]="title.trim() ? null : ariaLabel"
      (cancel)="onCancel($event)"
      (click)="onDialogClick($event)"
    >
      <div class="modal__panel" [class.modal__panel--flush]="bodyPadding === 'none'">
        @if (title.trim() || dismissible) {
          <header class="modal__header" [class.modal__header--close-only]="!title.trim()">
            @if (title.trim()) {
              <h2 class="modal__title">{{ title }}</h2>
            }
            <div class="modal__header-actions">
              <ng-content select="[modalHeaderActions]" />
              @if (dismissible) {
                <button
                  type="button"
                  class="icon-btn modal__close"
                  (click)="close()"
                  aria-label="Fechar"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              }
            </div>
          </header>
        }

        <div class="modal__body">
          <ng-content />
        </div>

        <footer class="modal__footer">
          <ng-content select="[modalFooter]" />
        </footer>
      </div>
    </dialog>
  `,
  styleUrl: './modal-shell.scss',
})
export class ModalShell implements AfterViewInit, OnDestroy {
  /** Titulo visivel. Vazio esconde o titulo e usa `ariaLabel` como nome acessivel. */
  @Input() title = '';

  /** sm 420px, md 640px (padrao), lg 920px, full ocupa a viewport. */
  @Input() size: 'sm' | 'md' | 'lg' | 'full' = 'md';

  /** `none` remove o padding do corpo, para layouts que sangram ate a borda. */
  @Input() bodyPadding: 'default' | 'none' = 'default';

  /** Quando false, Escape, clique no backdrop e o botao de fechar nao dispensam. */
  @Input() dismissible = true;

  /** Quando false, so Escape e o botao fecham (util em fluxos de varias etapas). */
  @Input() closeOnBackdrop = true;

  /** Nome acessivel quando nao ha titulo. */
  @Input() ariaLabel = 'Diálogo';

  @Output() readonly closed = new EventEmitter<void>();

  @ViewChild('dialog', { static: true }) private readonly dialogRef!: ElementRef<HTMLDialogElement>;

  ngAfterViewInit(): void {
    this.dialogRef.nativeElement.showModal();
    lockPageScroll();
  }

  ngOnDestroy(): void {
    const dialog = this.dialogRef.nativeElement;
    if (dialog.open) {
      dialog.close();
    }
    releasePageScroll();
  }

  /** Escape. O `preventDefault` evita o fechamento nativo: quem destroi o modal e o consumidor. */
  onCancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  /**
   * Clique no proprio `<dialog>` significa clique no backdrop: o painel interno cobre
   * toda a caixa do dialog, entao qualquer clique dentro do conteudo tem o painel (ou
   * um filho dele) como alvo, nunca o dialog.
   */
  onDialogClick(event: MouseEvent): void {
    if (event.target !== this.dialogRef.nativeElement || !this.closeOnBackdrop) {
      return;
    }
    this.close();
  }

  close(): void {
    if (!this.dismissible) {
      return;
    }
    this.closed.emit();
  }
}

/**
 * `showModal()` bloqueia interacao com o resto da pagina, mas nao o scroll do body.
 * Contador porque modais podem empilhar: so o ultimo a fechar devolve o scroll.
 */
function lockPageScroll(): void {
  openModalCount += 1;
  if (openModalCount === 1) {
    document.body.style.overflow = 'hidden';
  }
}

function releasePageScroll(): void {
  openModalCount = Math.max(0, openModalCount - 1);
  if (openModalCount === 0) {
    document.body.style.overflow = '';
  }
}
