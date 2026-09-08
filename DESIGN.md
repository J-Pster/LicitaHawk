# Design System LicitaHawk

**Princípio: sóbrio, denso, claro.** Produto de trabalho, não vitrine. A tela mostra dado, não enfeite; o brilho fica reservado para a ação que importa.

Este documento descreve o design **como ele existe** em `frontend/`. A fonte da verdade é `frontend/src/styles.scss` (tokens e classes globais) mais os componentes em `frontend/src/app/shared/`. Na dúvida, leia esses arquivos, não este resumo. A vitrine viva de tudo que está descrito aqui é a rota `/app/ui-kit` (visível na sidebar em modo dev).

A UI é orientada a tokens (CSS custom properties). **Nenhum componente hardcoda cor de chrome.** Duas exceções honestas:

1. **Cores funcionais de status** (verde ok, âmbar atenção, vermelho erro, azul em andamento, cinza neutro) são hex fixo por design: carregam significado, não estilo. Ficam em `app-status-badge` e nos toasts.
2. **A paleta bruta** (`--color-navy-*`, `--color-gold-*`) aparece direto em dois lugares onde a marca é o próprio chrome: a sidebar e o botão primário.

---

## 1. Marca e cor

A identidade são **dois tons**: o navy profundo e o dourado.

| Papel | Cor | Onde aparece |
|-------|-----|--------------|
| **Navy** | `--color-navy-900` a `--color-navy-600` | Sidebar, botão secundário, foco, link, item ativo de lista, títulos |
| **Dourado** | `--color-gold-500` / `--color-gold-400` | Botão primário, marca na sidebar, item de navegação ativo, badge Pro |

A regra que mantém isso legível: **o azul é o chrome, o dourado é o ato.** Navegação, foco e estados usam navy; a ação principal de cada tela usa dourado, e só ela. Uma tela com três botões dourados não tem ação principal nenhuma.

### Tokens de cor (`:root` em `styles.scss`)

**Paleta bruta** (não use direto em componente novo): `--color-navy-900|800|700|600`, `--color-gold-500|400|100`, `--color-slate-50|100|200|400|600|900`, `--color-white`, `--color-teal-600`, `--color-terracotta-500`.

**Funcionais**: `--color-success`, `--color-success-bg`, `--color-danger`, `--color-danger-bg`, `--color-warning`, `--color-warning-bg`, `--color-info`, `--color-info-bg`, `--color-border`.

**Semânticos** (é o que você usa):

| Token | Papel |
|-------|-------|
| `--surface` / `--panel` | Fundo de card, painel, input, menu |
| `--panel-muted` | Área levemente recuada (rodapé de modal, form embutido, estado vazio) |
| `--page-bg` | Fundo da página |
| `--heading` | Cor de título (`h1`-`h4` já herdam) |
| `--text` | Texto principal |
| `--text-muted` | Texto secundário, rótulo, placeholder de descrição |
| `--text-fine` | Timestamp, chevron, placeholder de input |
| `--link` / `--accent` | Azul de interação (o mesmo valor; `--accent` é o nome usado pelos componentes) |
| `--accent-hover` | Interação em hover |
| `--brand-gold` / `--brand-gold-hover` / `--on-gold` | Par do botão primário |
| `--active-bg` / `--active-text` | Fundo escuro de alto contraste (botão secundário, toggle ativo) |
| `--hover-bg` | Preenchimento padrão de hover |
| `--focus-ring` | Anel de foco (`box-shadow: 0 0 0 3px var(--focus-ring)`) |
| `--overlay-scrim` / `--overlay-blur` | Backdrop de modal e da gaveta mobile |
| `--skeleton-base` / `--skeleton-highlight` | Paradas do shimmer |

**Não invente token global para um componente só.** Reuse os acima ou uma variável local dentro do próprio componente.

### Tema claro e escuro

Três estados, não dois: **claro**, **escuro** e **seguir o sistema** (padrão). O CSS resolve nos dois sentidos:

- sem atributo em `:root` vale `prefers-color-scheme`;
- `:root[data-theme="light"|"dark"]` sobrepõe a escolha do usuário.

Quem escreve o atributo é `core/theme.service.ts`, que persiste em `localStorage` e é injetado no `App` para aplicar antes da primeira pintura. O botão do topbar cicla claro → escuro → sistema.

Os pares navy/dourado (sidebar, botões, badges) são auto-contrastantes e **não mudam** no escuro, de propósito: o que muda são os neutros (fundo, texto, borda, sombra).

---

## 2. Tipografia

Duas famílias, carregadas do Google Fonts em `styles.scss`:

- **Sora** (600/700/800) para títulos, via `--font-heading`. Já aplicada em `h1`-`h4`.
- **Inter** (400/500/600/700) para o resto, via `--font-body`.

Nunca redeclare `font-family` num componente: herde do body, e em controles interativos use `font-family: var(--font-body)` (senão o navegador cai na fonte do sistema).

### Escala em uso

| rem | px | Uso |
|-----|----|-----|
| `0.65rem` | ~10px | Rótulo de seção de menu (overline em uppercase) |
| `0.72rem` | ~12px | Overline, dica de opção |
| `0.78rem`-`0.8rem` | ~13px | Cabeçalho de tabela, dica de formulário, chip |
| `0.85rem` | ~14px | Rótulo de campo, item de menu, botão pequeno |
| `0.88rem` | ~14px | Célula de tabela, corpo denso |
| `0.95rem` | ~15px | Corpo padrão, input, botão |
| `1.05rem`-`1.15rem` | ~17-18px | Título de modal, de painel, do topbar |
| `1.25rem` | 20px | Título de página (`app-page-header`) |

Pesos: 400 leitura, 500 rótulo, 600 título e ênfase, 700 número de destaque e badge.

**Não aumente o denso.** 13px de rótulo e 14px de célula são escolha, não descuido: a tela é de trabalho e cabe mais informação por rolagem.

---

## 3. Espaçamento, raio, sombra, transição

Base **4px**, exposta em `--space-1` (4px) a `--space-8` (32px). Padrões que se repetem: célula de tabela `12px`, linha de menu `8px 12px`, corpo de card `20px`, painel largo `28px`, gap de formulário `18px`.

| Raio | Valor | Uso |
|------|-------|-----|
| `--radius-sm` | 6px | Input, chip de menu, botão de ícone, painel de dropdown |
| `--radius-md` | 10px | Botão, seção expansível, form embutido, estado vazio |
| `--radius-lg` | 16px | Card, painel de modal |
| `--radius-pill` | 999px | Badge, chip, avatar |

Sombras: `--shadow-sm` (card em repouso), `--shadow-md` (dropdown, hover de botão), `--shadow-lg` (modal, gaveta).

Transições: `--transition-fast` (0.15s) para hover, borda e chevron; `--transition-base` (0.25s) para mudanças maiores. Tudo que anima respeita `prefers-reduced-motion` (regra global no fim de `styles.scss`).

---

## 4. Botões (`styles.scss`)

Existe **um** sistema de botão. Use `.btn` + variante; não reescreva botão em SCSS de componente.

| Classe | Preenchimento | Texto | Quando |
|--------|---------------|-------|--------|
| `.btn-primary` | `--brand-gold` | `--on-gold` | A ação principal da tela. Uma por tela. |
| `.btn-secondary` | `--active-bg` (navy) | branco | Ação forte que não é a principal |
| `.btn-outline` | transparente | `--heading` | Ação alternativa, cancelar |
| `.btn-ghost` | transparente | `--text` | Ação terciária dentro de barra densa |
| `.btn-danger` | `--color-danger` | branco | Confirmação destrutiva |
| `.btn-danger-outline` | transparente | vermelho | Abrir um fluxo destrutivo |
| `.btn-link` | nenhum | `--link` | Ação que é texto ("ver como via API") |

Tamanhos: `.btn-sm`, `.btn-xs`, `.btn-block`. Botão só de ícone é `.icon-btn` (34px, `.icon-btn--sm` 28px, `.icon-btn--bordered` com moldura). Todo botão tem foco visível (`outline: 2px solid var(--accent)`), e todo `.icon-btn` precisa de `aria-label`.

---

## 5. Formulários

Duas camadas, e a de cima é a preferida.

**Componentes** (`app-text-field`, `app-select-field`): já entregam rótulo, `id`/`for`, dica, erro, `aria-describedby` e `aria-invalid` corretos. Implementam `ControlValueAccessor`, então funcionam com `[(ngModel)]` e reactive forms.

```html
<app-text-field
  label="Palavra-chave"
  placeholder="ex.: merenda escolar"
  hint="Busca no objeto e no órgão da licitação."
  [clearable]="true"
  [(ngModel)]="keyword"
  name="keyword"
/>
```

**Classes globais** (`.form-group`, `.form-label`, `.form-input`, `.form-hint`, `.form-error`, `.form-row`, `.inline-form`): para quando o campo é atípico (textarea, input com máscara própria, controle composto). Mesmo visual, mesmo anel de foco.

Regras que valem para os dois:

- Erro **substitui** a dica, não empilha em cima dela.
- Erro fica junto do campo. Toast é para retorno de ação, nunca para validação de campo.
- Seleção múltipla usa `app-multi-select`, **nunca** `<select multiple>` nativo.
- Escolha única continua `<select>` nativo por dentro (`app-select-field`): teclado, busca por digitação e a roda do mobile vêm de graça.

---

## 6. Dropdowns, menus e busca

`app-dropdown-popover` é a base de tudo que flutua. Posicionamento em `position: fixed` calculado do `getBoundingClientRect()` do gatilho, com flip vertical e clamp horizontal, fechando em clique fora e Escape. É o mesmo raciocínio do Overlay do CDK feito à mão, para o projeto não carregar `@angular/cdk` inteiro por causa de um menu.

O estado aberto/fechado **pertence a quem usa**: o popover só emite `(dismissed)`.

O chrome do painel é global e reaproveitável sem o componente: `.menu-panel`, `.menu-section-label`, `.menu-item` (com `.is-active` para o item sob o cursor/teclado e `.is-selected` para o escolhido), `.menu-divider`.

Em cima dessa base:

- **`app-multi-select`** — gatilho com resumo ("3 UFs"), busca embutida, selecionar tudo / limpar, checkbox por linha.
- **`app-search-select`** — campo de busca com sugestões. Aceita lista local (`options`) ou busca remota (`searchFn`), com debounce, mínimo de caracteres, navegação por setas, Enter para escolher e uma ação opcional no estado vazio ("Cadastrar órgão"). Resposta atrasada de uma busca antiga é descartada por guarda de sequência, então a lista nunca volta para um termo abandonado.

---

## 7. Modais

**Todo modal usa `app-modal-shell`.** Não existe overlay artesanal no projeto.

Invariante de layout: **cabeçalho fixo, corpo rolando sozinho, rodapé fixo.** As ações ficam sempre visíveis, não importa o tamanho do conteúdo.

Por baixo é o `<dialog>` nativo com `showModal()`, e não um `position: fixed` com z-index alto. O motivo é estrutural: o dialog modal vai para o *top layer* do navegador, acima de qualquer stacking context da página, então nenhum ancestral com `transform`/`filter` consegue enterrá-lo atrás da sidebar. De brinde vêm foco preso, Escape e `::backdrop` nativos.

```html
@if (open()) {
  <app-modal-shell title="Editar filtro" (closed)="open.set(false)">
    <p>Conteúdo.</p>
    <div modalFooter>
      <button class="btn btn-outline" (click)="open.set(false)">Cancelar</button>
      <button class="btn btn-primary" (click)="save()">Salvar</button>
    </div>
  </app-modal-shell>
}
```

- O consumidor cria e destrói com `@if`; o shell não guarda estado de visibilidade.
- `size`: `sm` (420px), `md` (640px, padrão), `lg` (920px), `full`.
- `bodyPadding="none"` para layouts que sangram até a borda.
- Slots: conteúdo padrão, `[modalFooter]`, `[modalHeaderActions]`. Rodapé sem nada projetado some por inteiro.
- Toda confirmação ("tem certeza?") usa `app-confirm-dialog`, que já monta o par cancelar/confirmar, o estado `busy` e a variante destrutiva.

---

## 8. Shell: sidebar e topbar

**Sidebar** (`app/shell/`): fundo `--color-navy-900`, texto branco a 72% de opacidade, item ativo em **dourado sólido** (o único lugar do chrome onde a marca vira fundo). Três estados, não dois:

1. **Expandida** (232px) no desktop;
2. **Recolhida** (68px, só ícones) — a escolha vai para o `localStorage`;
3. **Gaveta sobreposta** no mobile (≤860px), aberta pelo botão de menu do topbar, com scrim clicável.

Os itens são **dado, não markup**: `NAV_SECTIONS` em `app-shell.ts`. Adicionar tela = adicionar um item ali e uma rota. Item com `devOnly: true` só aparece em `isDevMode()`.

**Topbar**: `--surface`, sticky, borda inferior, altura ~61px. Contém o botão de menu (só no mobile), o título da página (vem de `data.title` da rota, resolvido na rota mais profunda), o botão de tema e o menu do usuário (avatar com inicial + email, abrindo um `app-dropdown-popover` alinhado à direita).

---

## 9. Tabelas

Chrome global: `.table-scroll` (rolagem horizontal em telas estreitas) envolvendo `.data-table`.

- `th`: 12px uppercase, `--text-muted`, borda inferior.
- `td`: 12px de padding, borda fina entre linhas, última linha sem borda.
- `tr.clickable-row`: cursor de mão e hover `--hover-bg`. Linha clicável **precisa** de um alvo de teclado equivalente (um link ou botão dentro da linha); não deixe a única forma de abrir um item ser o clique na linha.
- `.col-actions` para a coluna de botões, com `.icon-btn--bordered` de 28-34px.

Enquanto carrega, use `app-skeleton variant="table"` com o número real de colunas: a altura não muda quando os dados chegam.

---

## 10. Estados: vazio, carregando, erro

- **Carregando**: `app-skeleton` (`lines`, `table`, `card`). Só use texto "Carregando..." quando não dá para prever o formato.
- **Vazio**: `app-empty-state` com título, dica e **uma saída** (botão projetado). Estado vazio sem próximo passo é beco sem saída.
- **Erro de requisição**: `.alert alert-error` na região afetada, ou toast quando o erro é de uma ação pontual.
- **Retorno de ação**: `ToastService` (`success`, `error`, `warning`, `info`, `loading`). O `loading` não expira sozinho: quem abriu fecha com `dismiss(id)`.

---

## 11. Selos de estado

`app-status-badge` com `tone`: `success`, `info`, `warning`, `danger`, `neutral`. Pílula, 12px, peso 600.

São as únicas cores fora da paleta da marca, porque carregam significado: verde = ok/ativa, azul = em andamento, âmbar = pendente/atenção, vermelho = falhou/negada, cinza = encerrada/neutra. **Nunca** use um selo colorido como decoração: para etiqueta neutra existe a classe `.chip`.

Para plano de assinatura o vocabulário é outro: `.badge-free`, `.badge-starter`, `.badge-pro`.

---

## 12. Acessibilidade (mínimo não negociável)

- Todo controle interativo tem foco visível. Não remova outline sem repor equivalente.
- Botão só de ícone tem `aria-label`.
- Disclosure tem `aria-expanded` + `aria-controls` (ver `app-collapsible-section`).
- Dropdown tem `aria-haspopup` e `aria-expanded` no gatilho; lista de opções usa `role="listbox"`/`role="option"`.
- Campo tem rótulo real (`<label for>`), erro ligado por `aria-describedby` e `aria-invalid`.
- Toast fica em região `aria-live="polite"`; só o de erro usa `role="alert"`.
- Animação respeita `prefers-reduced-motion`.

---

## 13. Responsivo

| Faixa | O que muda |
|-------|-----------|
| ≤640px | `.form-row` e `.detail-list` viram uma coluna; rodapé de modal empilha em botões de largura total; toasts ocupam a largura |
| ≤860px | Sidebar vira gaveta sobreposta; topbar ganha o botão de menu; email some do botão de usuário |

Conteúdo tem largura máxima de `--content-max-w` (1280px) e é centralizado.

---

## 14. Onde cada coisa mora

```
frontend/src/
  styles.scss                     tokens + classes globais (fonte da verdade)
  app/core/                       serviços de aplicação (auth, conta, tema, toast)
  app/shared/                     componentes reutilizáveis (barril em shared/index.ts)
    collapsible-section/  dropdown/  empty-state/  forms/  help-tooltip/
    modal/  page-header/  search-select/  skeleton/  status-badge/  toast/
  app/shell/                      sidebar + topbar do produto autenticado
  app/pages/<tela>/               tela e seus componentes privados
    components/                   componente que só serve àquela tela
  app/pages/ui-kit/               vitrine viva do design system
```

Regra prática: **componente usado por duas telas mora em `shared/` e é exportado no barril**. Componente de uma tela só fica em `pages/<tela>/components/`. Mover para `shared/` cedo demais cria abstração errada; deixar duplicado depois de dois usos cria divergência visual.

---

## 15. Faça e não faça

### Faça
- Use token para toda cor de chrome: `--text`, `--surface`, `--color-border`, `--hover-bg`.
- Use `.btn` + variante; a ação principal é `.btn-primary` (dourado), uma por tela.
- Use `app-text-field` / `app-select-field` / `app-multi-select` nos formulários.
- Use `app-modal-shell` em todo modal e `app-confirm-dialog` em toda confirmação.
- Use `var(--hover-bg)` para hover e `0 0 0 3px var(--focus-ring)` para foco.
- Use cor de status só para estado funcional.
- Confira `/app/ui-kit` antes de escrever um componente novo.

### Não faça
- Não hardcode cor de chrome (`#fff`, `#111`, `rgba(0,0,0,...)` solto).
- Não pinte o chrome de dourado além da ação principal e do item ativo da sidebar.
- Não construa overlay/modal próprio, nem posicione dropdown com `z-index` grande na mão.
- Não use `<select multiple>` nativo.
- Não aumente o denso (rótulo 13px, célula 14px) para 16px.
- Não deixe estado vazio sem saída, nem tabela clicável sem alvo de teclado.
- Não use o caractere travessão (em dash) em lugar nenhum do código ou da documentação.
