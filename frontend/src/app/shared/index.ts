/**
 * Ponto unico de import dos componentes compartilhados.
 *
 *   import { ModalShell, ConfirmDialog, TextField } from '../../shared';
 *
 * Regra pratica: se dois lugares precisam da mesma peca de UI, ela mora aqui e e
 * exportada nesta lista. Componente que so serve a uma tela fica na pasta daquela
 * tela (`pages/<tela>/components/`), nao aqui.
 */
export { CodeBlock } from './code-block/code-block';
export { CollapsibleSection } from './collapsible-section/collapsible-section';
export { DragScroll } from './drag-scroll/drag-scroll';
export { DropdownPopover } from './dropdown/dropdown-popover';
export { MultiSelect, type MultiSelectOption } from './dropdown/multi-select';
export { EmptyState } from './empty-state/empty-state';
export { SelectField, type SelectFieldOption } from './forms/select-field';
export { TextField } from './forms/text-field';
export { HelpTooltip } from './help-tooltip/help-tooltip';
export { ConfirmDialog } from './modal/confirm-dialog';
export { ModalShell } from './modal/modal-shell';
export { PageHeader } from './page-header/page-header';
export { SearchSelect, type SearchOption } from './search-select/search-select';
export { Skeleton } from './skeleton/skeleton';
export { StatusBadge, type StatusTone } from './status-badge/status-badge';
export { ToastHost } from './toast/toast-host';
