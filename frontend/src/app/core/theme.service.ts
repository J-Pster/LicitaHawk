import { Injectable, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'licitahawk.theme';

/**
 * Preferencia de tema do usuario, persistida em localStorage.
 *
 * O CSS resolve o tema em duas frentes (ver `styles.scss`): sem atributo `data-theme`
 * vale o `prefers-color-scheme` do sistema; com `data-theme="light"|"dark"` a escolha
 * do usuario ganha. Este service so escreve/limpa esse atributo -- nao existe uma
 * segunda copia dos tokens em JS.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _preference = signal<ThemePreference>(readStoredPreference());

  /** O que o usuario escolheu ('system' = seguir o SO). */
  readonly preference = this._preference.asReadonly();

  constructor() {
    this.apply(this._preference());
  }

  set(preference: ThemePreference): void {
    this._preference.set(preference);
    if (preference === 'system') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, preference);
    }
    this.apply(preference);
  }

  /** Cicla claro -> escuro -> sistema, que e a ordem que o botao do header usa. */
  cycle(): void {
    const next: Record<ThemePreference, ThemePreference> = {
      light: 'dark',
      dark: 'system',
      system: 'light',
    };
    this.set(next[this._preference()]);
  }

  /** Tema efetivamente pintado agora, ja resolvendo 'system'. */
  resolved(): 'light' | 'dark' {
    const preference = this._preference();
    if (preference !== 'system') {
      return preference;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  private apply(preference: ThemePreference): void {
    const root = document.documentElement;
    if (preference === 'system') {
      root.removeAttribute('data-theme');
      return;
    }
    root.setAttribute('data-theme', preference);
  }
}

function readStoredPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}
