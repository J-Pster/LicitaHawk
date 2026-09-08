import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { localOnlyGuard } from './core/local-only.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/landing/landing').then((m) => m.Landing),
  },
  {
    path: 'login',
    loadComponent: () => import('./pages/login/login').then((m) => m.Login),
  },
  {
    path: 'payment',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/payment/payment').then((m) => m.Payment),
  },
  {
    path: 'app',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/app-shell').then((m) => m.AppShell),
    children: [
      { path: '', redirectTo: 'inicio', pathMatch: 'full' },
      // Rota antiga (link salvo, e-mail de checkout): mantida como redirect, nao mais como tela.
      { path: 'dashboard', redirectTo: 'inicio', pathMatch: 'full' },
      {
        path: 'inicio',
        loadComponent: () => import('./pages/overview/overview').then((m) => m.Overview),
        data: { title: 'Visão geral' },
      },
      {
        path: 'buscar',
        loadComponent: () =>
          import('./pages/tender-search/tender-search').then((m) => m.TenderSearch),
        data: { title: 'Buscar licitações' },
      },
      {
        path: 'filtros',
        loadComponent: () =>
          import('./pages/saved-filters/saved-filters').then((m) => m.SavedFilters),
        data: { title: 'Filtros salvos' },
      },
      {
        path: 'salvas',
        loadComponent: () =>
          import('./pages/saved-tenders/saved-tenders').then((m) => m.SavedTenders),
        data: { title: 'Licitações salvas' },
      },
      {
        path: 'alertas',
        loadComponent: () => import('./pages/alerts/alerts').then((m) => m.Alerts),
        data: { title: 'Alertas' },
      },
      {
        path: 'conta',
        loadComponent: () => import('./pages/account/account').then((m) => m.Account),
        data: { title: 'Plano e cobrança' },
      },
      {
        path: 'uso',
        loadComponent: () => import('./pages/usage/usage').then((m) => m.Usage),
        data: { title: 'Uso' },
      },
      {
        path: 'api-keys',
        loadComponent: () => import('./pages/api-keys/api-keys').then((m) => m.ApiKeys),
        data: { title: 'API keys' },
      },
      {
        path: 'webhooks',
        loadComponent: () => import('./pages/webhooks/webhooks').then((m) => m.Webhooks),
        data: { title: 'Webhooks' },
      },
      {
        path: 'mcp',
        loadComponent: () => import('./pages/mcp/mcp').then((m) => m.Mcp),
        data: { title: 'Servidor MCP' },
      },
      {
        path: 'docs',
        loadComponent: () => import('./pages/api-docs/api-docs').then((m) => m.ApiDocs),
        data: { title: 'Documentação da API' },
      },
      {
        // Vitrine do design system: ferramenta de desenvolvimento, nao funcionalidade do
        // produto. canMatch (nao canActivate) para a rota simplesmente nao existir fora do
        // localhost -- por URL direta em producao ela nem casa, e o usuario cai no fallback.
        path: 'ui-kit',
        canMatch: [localOnlyGuard],
        loadComponent: () => import('./pages/ui-kit/ui-kit').then((m) => m.UiKit),
        data: { title: 'UI Kit' },
      },
      {
        path: 'tenders/:id',
        loadComponent: () =>
          import('./pages/tender-detail-page/tender-detail-page').then((m) => m.TenderDetailPage),
        data: { title: 'Detalhe da licitação' },
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
