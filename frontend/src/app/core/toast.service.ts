import { Injectable, signal } from '@angular/core';

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'loading';

export interface Toast {
  readonly id: string;
  readonly type: ToastType;
  readonly title: string;
  readonly message?: string;
  readonly dismissible: boolean;
}

/** Duracao padrao por tipo. `loading` nao expira sozinho: quem abriu fecha. */
const DEFAULT_DURATION_MS: Record<ToastType, number | null> = {
  success: 4000,
  info: 5000,
  warning: 7000,
  error: 9000,
  loading: null,
};

/**
 * Fila de toasts do produto. Uma unica pilha, no canto superior direito,
 * renderizada pelo `<app-toast-host>` montado uma vez em `app.html`.
 *
 * Toast e para retorno de acao ("chave copiada", "filtro salvo", "falha ao salvar"),
 * nao para erro de formulario: erro de campo fica junto do campo.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 0;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly _toasts = signal<readonly Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  success(title: string, message?: string): string {
    return this.show('success', title, message);
  }

  error(title: string, message?: string): string {
    return this.show('error', title, message);
  }

  warning(title: string, message?: string): string {
    return this.show('warning', title, message);
  }

  info(title: string, message?: string): string {
    return this.show('info', title, message);
  }

  /** Toast persistente para operacao em andamento. Feche com `dismiss(id)`. */
  loading(title: string, message?: string): string {
    return this.show('loading', title, message);
  }

  show(type: ToastType, title: string, message?: string, durationMs?: number | null): string {
    const id = `toast-${this.nextId++}`;
    const dismissible = type !== 'loading';
    this._toasts.update((list) => [...list, { id, type, title, message, dismissible }]);

    const duration = durationMs === undefined ? DEFAULT_DURATION_MS[type] : durationMs;
    if (duration !== null) {
      this.timers.set(
        id,
        setTimeout(() => this.dismiss(id), duration),
      );
    }
    return id;
  }

  dismiss(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this._toasts.update((list) => list.filter((toast) => toast.id !== id));
  }

  dismissAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this._toasts.set([]);
  }
}
