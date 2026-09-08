import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ToastService } from '../../core/toast.service';
import {
  CollapsibleSection,
  ConfirmDialog,
  EmptyState,
  HelpTooltip,
  ModalShell,
  MultiSelect,
  type MultiSelectOption,
  PageHeader,
  SearchSelect,
  type SearchOption,
  SelectField,
  Skeleton,
  StatusBadge,
  TextField,
} from '../../shared';
import { UFS } from '../../common/ufs';

const UF_OPTIONS: readonly MultiSelectOption[] = UFS.map((uf) => ({ value: uf, label: uf }));

const ORGAOS_DEMO: readonly SearchOption[] = [
  { value: '1', label: 'Prefeitura Municipal de Goiânia', hint: 'GO - 01.612.092/0001-23' },
  { value: '2', label: 'Governo do Estado de São Paulo', hint: 'SP - 46.377.222/0001-29' },
  { value: '3', label: 'Universidade Federal de Minas Gerais', hint: 'MG - 17.217.985/0001-04' },
  { value: '4', label: 'Tribunal de Justiça do Paraná', hint: 'PR - 77.821.841/0001-94' },
];

/**
 * Vitrine viva do design system: cada peca de `shared/` aparece aqui em uso real.
 *
 * Serve pra duas coisas: conferir num lugar so como um componente se comporta nos
 * dois temas, e evitar que alguem reimplemente na mao algo que ja existe. So
 * aparece na navegacao em modo de desenvolvimento (`isDevMode()` no shell), mas a
 * rota existe nos dois modos para poder ser aberta direto pela URL.
 */
@Component({
  selector: 'app-ui-kit',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    CollapsibleSection,
    ConfirmDialog,
    EmptyState,
    HelpTooltip,
    ModalShell,
    MultiSelect,
    PageHeader,
    SearchSelect,
    SelectField,
    Skeleton,
    StatusBadge,
    TextField,
  ],
  templateUrl: './ui-kit.html',
  styleUrl: './ui-kit.scss',
})
export class UiKit {
  private readonly toastService = inject(ToastService);

  readonly ufOptions = UF_OPTIONS;
  readonly selectedUfs = signal<string[]>(['GO', 'SP']);

  readonly keyword = signal('');
  readonly sort = signal('desc');
  readonly sortOptions = [
    { value: 'desc', label: 'Mais recentes primeiro' },
    { value: 'asc', label: 'Mais antigas primeiro' },
  ];

  readonly orgao = signal<SearchOption | null>(null);
  readonly modalOpen = signal(false);
  readonly confirmOpen = signal(false);
  readonly confirmBusy = signal(false);
  readonly sectionOpen = signal(true);

  /** Simula uma busca remota (300ms) para exercitar debounce, loading e ordem de resposta. */
  readonly buscarOrgaos = async (term: string): Promise<readonly SearchOption[]> => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const needle = term.toLowerCase();
    return ORGAOS_DEMO.filter(
      (o) => o.label.toLowerCase().includes(needle) || (o.hint?.toLowerCase().includes(needle) ?? false),
    );
  };

  showToast(kind: 'success' | 'error' | 'warning' | 'info'): void {
    const samples = {
      success: ['Filtro salvo', 'Você recebe alertas quando surgirem novas licitações.'],
      error: ['Falha ao salvar', 'A API respondeu 500. Tente de novo em instantes.'],
      warning: ['Limite quase no fim', 'Você usou 900 das 1.000 requisições do mês.'],
      info: ['Busca em andamento', 'Estamos consultando o PNCP.'],
    } as const;
    const [title, message] = samples[kind];
    this.toastService.show(kind, title, message);
  }

  confirmDelete(): void {
    this.confirmBusy.set(true);
    setTimeout(() => {
      this.confirmBusy.set(false);
      this.confirmOpen.set(false);
      this.toastService.success('Filtro removido');
    }, 700);
  }
}
