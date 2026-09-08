import { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 (nao 5) nao captura rejeicao de Promise dentro de handler async -- sem isso, um erro
// nao tratado (ex.: JSON.parse de um cursor de paginacao invalido vindo do cliente) derruba o
// processo Node inteiro, tirando TODOS os clientes do ar (achado real da revisao de qualidade,
// nao hipotetico -- reproduzido com ?cursor=invalido em GET /v1/orgaos/:cnpj/tenders).
// Todo handler async de rota deve passar por aqui; o erro cai no middleware global de
// tratamento de erro registrado no fim de src/server.ts.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
