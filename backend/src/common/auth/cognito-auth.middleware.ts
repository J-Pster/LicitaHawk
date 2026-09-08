import { RequestHandler } from "express";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { env } from "../../config/env";

export interface CognitoAuthContext {
  sub: string;
  email?: string;
}

declare global {
  namespace Express {
    interface Request {
      cognitoUser?: CognitoAuthContext;
    }
  }
}

export {};

// Verifica so a assinatura (via JWKS do User Pool) + token_use/clientId -- aws-jwt-verify e' a
// lib oficial da AWS pra isso, sem precisar do SDK inteiro do Cognito (que exigiria credenciais
// AWS so pra validar um token que o proprio frontend ja obteve direto do Cognito). tokenUse: "id"
// porque o frontend manda o ID token (carrega email), nao o access token. Criado uma unica vez no
// boot -- o cache de JWKS (chaves publicas) e' compartilhado entre todas as verificacoes.
const verifier = CognitoJwtVerifier.create({
  userPoolId: env.cognitoUserPoolId,
  tokenUse: "id",
  clientId: env.cognitoClientId,
});

function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (authorizationHeader?.startsWith("Bearer ")) {
    return authorizationHeader.slice("Bearer ".length).trim();
  }
  return undefined;
}

/**
 * Autentica rotas de GESTAO DE CONTA (src/account/) via ID token do Cognito -- diferente de
 * `authenticate` (src/common/auth/api-key.middleware.ts), que autentica as rotas de PRODUTO via
 * API key. O frontend faz signup/login DIRETO contra o Cognito (sem passar pelo backend) e manda
 * o ID token aqui em 'Authorization: Bearer <idToken>'. Sucesso injeta req.cognitoUser = { sub,
 * email } -- 'sub' e' o identificador unico e estavel do usuario no Cognito, vira o customer_id
 * do produto (ver src/account/account.service.ts).
 */
export const cognitoAuthenticate: RequestHandler = async (req, res, next) => {
  const token = extractBearerToken(req.header("authorization"));
  if (!token) {
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "ID token do Cognito ausente. Envie 'Authorization: Bearer <idToken>'.",
      },
    });
    return;
  }

  try {
    const payload = await verifier.verify(token);
    req.cognitoUser = {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
    next();
  } catch (err) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "ID token do Cognito invalido ou expirado." } });
  }
};
