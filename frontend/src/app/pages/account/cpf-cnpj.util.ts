/** Mantém só os dígitos -- é o formato que o backend (`POST /checkout`) espera receber. */
export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * Aplica a máscara de CPF (000.000.000-00) ou CNPJ (00.000.000/0000-00) progressivamente
 * enquanto o usuário digita, decidindo o formato pela quantidade de dígitos já informados.
 */
export function formatCpfCnpjInput(raw: string): string {
  const digits = digitsOnly(raw).slice(0, 14);

  if (digits.length <= 11) {
    return digits
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }

  return digits
    .replace(/(\d{2})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1/$2')
    .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}

function isValidCpf(digits: string): boolean {
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) {
    return false;
  }
  const nums = digits.split('').map(Number);
  const checkDigit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += nums[i] * (len + 1 - i);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return checkDigit(9) === nums[9] && checkDigit(10) === nums[10];
}

function isValidCnpj(digits: string): boolean {
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) {
    return false;
  }
  const nums = digits.split('').map(Number);
  const checkDigit = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += nums[i] * weights[i];
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return checkDigit(12) === nums[12] && checkDigit(13) === nums[13];
}

/** Valida formato (11 ou 14 dígitos) e dígito verificador. Retorna a mensagem de erro, ou `null`
 * quando válido -- pronto para plugar direto no `[error]` do `app-text-field`. */
export function validateCpfCnpj(raw: string): string | null {
  const digits = digitsOnly(raw);
  if (digits.length !== 11 && digits.length !== 14) {
    return 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).';
  }
  const valid = digits.length === 11 ? isValidCpf(digits) : isValidCnpj(digits);
  if (!valid) {
    return digits.length === 11 ? 'CPF inválido.' : 'CNPJ inválido.';
  }
  return null;
}
