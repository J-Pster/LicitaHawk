import { CanMatchFn } from '@angular/router';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Verdadeiro somente quando a aplicacao esta sendo servida da propria maquina.
 *
 * Serve de base para tudo que e ferramenta de desenvolvimento: esconder o item de menu nao
 * basta, porque a rota continuaria acessivel por URL direta em producao.
 */
export function isLocalhost(): boolean {
  return LOCAL_HOSTNAMES.has(window.location.hostname);
}

/**
 * Guarda de rota para telas que so existem em desenvolvimento local (hoje, o UI Kit).
 *
 * `CanMatchFn` em vez de `CanActivateFn` de proposito: com `canMatch` a rota simplesmente nao
 * casa fora do localhost, entao o roteador segue para o `**` e o usuario cai no lugar certo,
 * em vez de ver uma tela em branco depois de um bloqueio.
 */
export const localOnlyGuard: CanMatchFn = () => isLocalhost();
