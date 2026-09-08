import { AfterViewInit, Directive, ElementRef, OnDestroy, inject } from '@angular/core';

/**
 * Distância em pixels que o ponteiro precisa percorrer para a interação virar arrasto.
 *
 * Existe porque ninguém clica parado: um clique comum move o ponteiro um ou dois pixels entre o
 * apertar e o soltar. Sem essa folga, todo clique numa linha da tabela seria interpretado como
 * arrasto e nunca abriria nada.
 */
const LIMIAR_DE_ARRASTO_PX = 5;

/** Elementos que têm ação própria: arrastar a partir deles seria roubar o clique de quem manda. */
const ALVOS_INTERATIVOS = 'a, button, input, select, textarea, [role="button"], dialog';

/**
 * Permite rolar um container na horizontal clicando e arrastando, como num mapa.
 *
 * O problema que isto resolve: numa tabela larga com linha clicável, arrastar para ver as colunas
 * da direita terminava abrindo o item ao soltar o botão, porque o navegador entende
 * apertar-mover-soltar sobre o mesmo elemento como um clique. Aqui, quando o ponteiro passa do
 * limiar, o clique seguinte é engolido na fase de captura: arrastar rola, clicar continua abrindo.
 *
 * Uso: `<div class="table-scroll" appDragScroll>`. A diretiva não presume nada sobre o conteúdo,
 * só que o elemento rola na horizontal.
 */
@Directive({
  selector: '[appDragScroll]',
  standalone: true,
  host: {
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(pointercancel)': 'onPointerCancel($event)',
  },
})
export class DragScroll implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  private arrastando = false;

  /**
   * As classes sao escritas direto no elemento, e nao por `[class.x]` no host.
   *
   * `can-drag-scroll` depende de medir o DOM (scrollWidth vs clientWidth), e um host binding so e
   * reavaliado quando o Angular roda change detection: redimensionar a janela nao dispara nada,
   * entao a classe ficava presa no valor de quando a tela tinha outra largura, mostrando cursor
   * de arrastar numa tabela que ja cabe inteira. O ResizeObserver observa a mudanca de verdade.
   */
  private observer: ResizeObserver | null = null;

  private pointerId: number | null = null;
  private origemX = 0;
  private scrollInicial = 0;
  /** Ligado no momento em que o arrasto começa; desligado logo depois de engolir o clique. */
  private bloquearProximoClique = false;

  constructor() {
    // Captura: precisamos ver o clique ANTES do (click) da linha da tabela, que é quem abriria o
    // item. Na fase de borbulha já seria tarde.
    this.host.nativeElement.addEventListener('click', this.onClickCapture, true);
  }

  ngAfterViewInit(): void {
    this.observer = new ResizeObserver(() => this.atualizarClasseDeRolagem());
    this.observer.observe(this.host.nativeElement);
    // Tambem o conteudo: linha adicionada ou removida muda a largura da tabela sem mexer no
    // tamanho do container.
    const conteudo = this.host.nativeElement.firstElementChild;
    if (conteudo) {
      this.observer.observe(conteudo);
    }
    this.atualizarClasseDeRolagem();
  }

  ngOnDestroy(): void {
    this.host.nativeElement.removeEventListener('click', this.onClickCapture, true);
    this.observer?.disconnect();
  }

  /** Folga de 1px: diferenca sub-pixel de layout nao e conteudo escondido. */
  private podeRolar(): boolean {
    const el = this.host.nativeElement;
    return el.scrollWidth - el.clientWidth > 1;
  }

  private atualizarClasseDeRolagem(): void {
    this.host.nativeElement.classList.toggle('can-drag-scroll', this.podeRolar());
  }

  protected onPointerDown(event: PointerEvent): void {
    // Só botão principal, e nunca a partir de um controle que tem ação própria.
    if (event.button !== 0 || (event.target as HTMLElement).closest(ALVOS_INTERATIVOS)) {
      return;
    }
    if (!this.podeRolar()) {
      return;
    }
    this.pointerId = event.pointerId;
    this.origemX = event.clientX;
    this.scrollInicial = this.host.nativeElement.scrollLeft;
  }

  protected onPointerMove(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) {
      return;
    }
    const deslocamento = event.clientX - this.origemX;

    if (!this.arrastando) {
      if (Math.abs(deslocamento) < LIMIAR_DE_ARRASTO_PX) {
        return;
      }
      this.arrastando = true;
      this.bloquearProximoClique = true;
      this.host.nativeElement.classList.add('is-drag-scrolling');
      // Segura o ponteiro: sem isso, arrastar rápido para fora da tabela perde os eventos no meio
      // do movimento e o conteúdo trava enquanto o botão ainda está apertado.
      //
      // Dentro de try: o navegador lança se o ponteiro já não estiver ativo (soltar o botão fora
      // da janela, gesto interrompido pelo sistema). Capturar é otimização de conforto, não o
      // mecanismo do arrasto, então uma falha aqui não pode derrubar a rolagem logo abaixo.
      try {
        this.host.nativeElement.setPointerCapture(event.pointerId);
      } catch {
        // segue sem captura: o arrasto continua funcionando enquanto o ponteiro estiver sobre o container
      }
    }

    // preventDefault evita a seleção de texto que o navegador começaria durante o arrasto.
    event.preventDefault();
    this.host.nativeElement.scrollLeft = this.scrollInicial - deslocamento;
  }

  protected onPointerUp(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) {
      return;
    }
    this.encerrar(event.pointerId);
  }

  protected onPointerCancel(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) {
      return;
    }
    // Cancelado pelo sistema (gesto do SO, troca de janela): não houve clique para engolir.
    this.bloquearProximoClique = false;
    this.encerrar(event.pointerId);
  }

  private encerrar(pointerId: number): void {
    try {
      if (this.host.nativeElement.hasPointerCapture(pointerId)) {
        this.host.nativeElement.releasePointerCapture(pointerId);
      }
    } catch {
      // o ponteiro já pode ter sido liberado pelo próprio navegador
    }
    this.pointerId = null;
    this.arrastando = false;
    this.host.nativeElement.classList.remove('is-drag-scrolling');
  }

  private readonly onClickCapture = (event: MouseEvent): void => {
    if (!this.bloquearProximoClique) {
      return;
    }
    this.bloquearProximoClique = false;
    event.preventDefault();
    event.stopPropagation();
  };
}
