interface CognitoErrorLike {
  code?: string;
  message?: string;
}

const MESSAGES: Record<string, string> = {
  UsernameExistsException: 'Já existe uma conta cadastrada com este email.',
  InvalidPasswordException:
    'Senha inválida. Use pelo menos 8 caracteres, com letra maiúscula, minúscula e número.',
  InvalidParameterException: 'Dados inválidos. Verifique o email e a senha informados.',
  NotAuthorizedException: 'Email ou senha incorretos.',
  UserNotFoundException: 'Não encontramos uma conta com este email.',
  UserNotConfirmedException: 'Sua conta ainda não foi confirmada. Digite o código enviado por email.',
  CodeMismatchException: 'Código de confirmação incorreto.',
  ExpiredCodeException: 'Este código expirou. Solicite um novo código.',
  LimitExceededException: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
  TooManyRequestsException: 'Muitas tentativas em sequência. Aguarde um instante e tente novamente.',
  TooManyFailedAttemptsException: 'Muitas tentativas incorretas. Aguarde antes de tentar novamente.',
  UserLambdaValidationException: 'Não foi possível validar o cadastro. Tente novamente.',
  AliasExistsException: 'Este email já está associado a outra conta.',
};

export function mapCognitoError(err: unknown): string {
  const cognitoErr = err as CognitoErrorLike;
  if (cognitoErr?.code && MESSAGES[cognitoErr.code]) {
    return MESSAGES[cognitoErr.code];
  }
  return cognitoErr?.message || 'Ocorreu um erro inesperado. Tente novamente.';
}
