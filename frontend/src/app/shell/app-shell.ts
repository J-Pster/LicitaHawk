import { Component, ElementRef, computed, inject, isDevMode, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter, map, tap } from 'rxjs';
import { AccountService } from '../core/account.service';
import { AuthService } from '../core/auth.service';
import { isLocalhost } from '../core/local-only.guard';
import { ThemeService } from '../core/theme.service';
import { DropdownPopover } from '../shared/dropdown/dropdown-popover';

export interface NavItem {
  readonly label: string;
  readonly route: string;
  /** Path do icone (viewBox 0 0 24 24, traco em currentColor). */
  readonly icon: string;
  readonly devOnly?: boolean;
  /** Chave opcional de um contador dinamico (ver `badgeCounts`). Item sem isso nunca mostra badge. */
  readonly badgeId?: string;
}

export interface NavSection {
  readonly label: string;
  readonly items: readonly NavItem[];
}

const SIDEBAR_STORAGE_KEY = 'licitahawk.sidebar-expanded';

/**
 * Navegacao do produto, declarada como dado e nao como markup repetido: adicionar
 * uma tela e adicionar um item aqui e uma rota em `app.routes.ts`.
 */
const NAV_SECTIONS: readonly NavSection[] = [
  {
    label: 'Visão geral',
    items: [
      {
        label: 'Visão geral',
        route: '/app/inicio',
        icon: 'M3 11.5 12 4l9 7.5M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9',
      },
    ],
  },
  {
    label: 'Licitações',
    items: [
      {
        label: 'Buscar',
        route: '/app/buscar',
        icon: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM21 21l-4.3-4.3',
      },
      {
        label: 'Filtros salvos',
        route: '/app/filtros',
        icon: 'M4 5h16l-6.5 7.5V19l-3 2v-8.5Z',
        badgeId: 'saved-filters',
      },
      {
        label: 'Licitações salvas',
        route: '/app/salvas',
        icon: 'M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z',
      },
      {
        label: 'Alertas',
        route: '/app/alertas',
        icon: 'M8 17a4 4 0 0 0 8 0M6 10a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10Z',
      },
    ],
  },
  {
    label: 'Conta',
    items: [
      {
        label: 'Plano e cobrança',
        route: '/app/conta',
        icon: 'M3 6h18v12H3ZM3 10h18M6 15h4',
      },
      {
        label: 'Uso',
        route: '/app/uso',
        icon: 'M4 20V10M10 20V4M16 20v-7M2 20h20',
      },
    ],
  },
  {
    label: 'Desenvolvedor',
    items: [
      {
        label: 'API keys',
        route: '/app/api-keys',
        icon: 'M14.5 3a5.5 5.5 0 0 0-5.4 6.6L3 15.7V19h3.3l1-1h2v-2h2l2.1-2.1A5.5 5.5 0 1 0 14.5 3ZM17 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
      },
      {
        label: 'Webhooks',
        route: '/app/webhooks',
        icon: 'M12 3a3 3 0 0 0-1.5 5.6L8 13H5a3 3 0 1 0 0 2h4.2l3.3-5.6A3 3 0 0 0 12 3Zm4 10a3 3 0 0 0-2.8 2h-2.4v2h2.4A3 3 0 1 0 16 13Z',
      },
      {
        label: 'MCP',
        route: '/app/mcp',
        icon: 'M6 3v4M10 3v4M8 7v4a4 4 0 0 0 4 4v0a4 4 0 0 0 4-4V7M12 15v6M9 21h6',
      },
      {
        label: 'Documentação',
        route: '/app/docs',
        icon: 'M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5ZM4 4.5v16M20 17H6.5a2.5 2.5 0 0 0-2.5 2.5',
      },
    ],
  },
  {
    label: 'Desenvolvimento',
    items: [
      {
        label: 'UI Kit',
        route: '/app/ui-kit',
        icon: 'M4 5h16M4 12h16M4 19h10',
        devOnly: true,
      },
    ],
  },
];

/**
 * Shell autenticado: sidebar colapsavel de dois niveis (secao + item) + topbar +
 * `<router-outlet>`.
 *
 * A sidebar tem tres estados, nao dois: expandida e recolhida no desktop (a
 * escolha fica no localStorage), e gaveta sobreposta no mobile, onde nao ha
 * largura pra uma coluna fixa. O mesmo markup serve aos tres; quem decide e o CSS
 * mais duas flags.
 */
@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, DropdownPopover],
  templateUrl: './app-shell.html',
  styleUrl: './app-shell.scss',
})
export class AppShell {
  private readonly authService = inject(AuthService);
  private readonly accountService = inject(AccountService);
  private readonly themeService = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** Query em signal: o template le a ancora do menu do usuario sem depender do
      ciclo de vida (um `@ViewChild` classico so aparece depois da primeira
      checagem, e a leitura no template dispararia ExpressionChanged em dev). */
  private readonly userTriggerRef = viewChild<ElementRef<HTMLElement>>('userTrigger');

  // Item de ferramenta de desenvolvimento exige as duas condicoes: build de dev E servido da
  // propria maquina. A mesma condicao vale na rota (localOnlyGuard), para o menu e o roteador
  // nunca discordarem sobre o que existe.
  readonly sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.devOnly || (isDevMode() && isLocalhost())),
  })).filter((section) => section.items.length > 0);

  readonly sidebarExpanded = signal(readStoredSidebarState());
  readonly drawerOpen = signal(false);
  readonly userMenuOpen = signal(false);

  /** Email de verdade (backend), nao o username do Cognito (que aqui e o sub/UUID). */
  readonly email = signal<string | null>(null);

  readonly themePreference = this.themeService.preference;

  /** Contadores dinamicos por `badgeId`, consultados pelos itens de nav que declaram um.
      Hoje so "Filtros salvos" usa isso (soma das contagens "novas" de cada filtro salvo),
      mas o mecanismo e generico para o proximo item que precisar de um badge. */
  readonly badgeCounts = computed<Record<string, number>>(() => ({
    'saved-filters': Object.values(this.accountService.savedSearchNewCounts()).reduce(
      (sum, count) => sum + count,
      0,
    ),
  }));

  constructor() {
    this.accountService
      .getMe()
      .then((account) => this.email.set(account.email))
      .catch(() => this.email.set(this.authService.currentEmail()));

    // A sidebar precisa do badge de "Filtros salvos" independente de qual pagina esteja
    // aberta, entao ela mesma dispara o carregamento central (AccountService dedupe
    // chamadas concorrentes, entao a tela de filtros salvos pode chamar de novo sem custo).
    void this.accountService.refreshSavedSearches();
  }

  // Nao chama deepestTitle() de forma sincrona aqui: durante a construcao do AppShell a
  // navegacao pra rota filha (lazy, via loadComponent) ainda esta em andamento e
  // this.route.firstChild.snapshot pode nao existir ainda -- so fica estavel apos o
  // NavigationEnd, que dispara logo em seguida.
  readonly pageTitle = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      // Navegou: fecha a gaveta e o menu do usuario, senao eles ficariam abertos
      // por cima da tela nova depois de um clique no proprio menu.
      tap(() => {
        this.drawerOpen.set(false);
        this.userMenuOpen.set(false);
      }),
      map(() => this.deepestTitle()),
    ),
    { initialValue: '' },
  );

  readonly userTriggerEl = computed(() => this.userTriggerRef()?.nativeElement ?? null);

  /** Inicial do email para o avatar. Vazio enquanto o backend nao respondeu. */
  readonly userInitial = computed(() => (this.email() ?? '?').charAt(0).toUpperCase());

  toggleSidebar(): void {
    this.sidebarExpanded.update((expanded) => {
      const next = !expanded;
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      return next;
    });
  }

  toggleDrawer(): void {
    this.drawerOpen.update((open) => !open);
  }

  closeDrawer(): void {
    this.drawerOpen.set(false);
  }

  toggleUserMenu(): void {
    this.userMenuOpen.update((open) => !open);
  }

  cycleTheme(): void {
    this.themeService.cycle();
  }

  themeLabel(): string {
    switch (this.themePreference()) {
      case 'light':
        return 'Tema claro (clique para escuro)';
      case 'dark':
        return 'Tema escuro (clique para seguir o sistema)';
      default:
        return 'Tema do sistema (clique para claro)';
    }
  }

  logout(): void {
    this.accountService.resetSavedSearchesState();
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  private deepestTitle(): string {
    let r: ActivatedRoute | null = this.route.firstChild;
    while (r?.firstChild) {
      r = r.firstChild;
    }
    return (r?.snapshot?.data?.['title'] as string | undefined) ?? '';
  }
}

function readStoredSidebarState(): boolean {
  return localStorage.getItem(SIDEBAR_STORAGE_KEY) !== 'false';
}
