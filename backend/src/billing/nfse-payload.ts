// Payload builder puro pro Focus NFe -- extraido da logica de
// pster-finance/apps/backend/src/focus/nfse.service.ts (buildPayload/buildTomador),
// sem a camada NestJS/TypeORM. Adaptado pro caso de uso do LicitaHawk: nota de
// assinatura SaaS (nao tem Customer/Payer entity aqui, entao os dados do
// tomador chegam como um objeto simples).

export interface BillingTomadorEndereco {
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  codigoMunicipio?: string;
  uf?: string;
  cep?: string;
}

export interface BillingTomador {
  razaoSocial: string;
  email?: string;
  telefone?: string;
  cpf?: string;
  cnpj?: string;
  inscricaoMunicipal?: string;
  endereco?: BillingTomadorEndereco;
}

export interface NfseTomador {
  cpf?: string;
  cnpj?: string;
  razao_social: string;
  inscricao_municipal?: string;
  email?: string;
  telefone?: string;
  endereco?: {
    logradouro?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    codigo_municipio?: string;
    uf?: string;
    cep?: string;
  };
}

export interface NfseServico {
  valor_servicos: number;
  base_calculo: number;
  iss_retido: boolean;
  item_lista_servico?: string;
  codigo_tributario_municipio?: string;
  aliquota?: number;
  codigo_municipio: string;
  discriminacao: string;
}

export interface NfsePayload {
  data_emissao: string;
  natureza_operacao: string;
  optante_simples_nacional: boolean;
  regime_especial_tributacao?: string;
  prestador: {
    cnpj: string;
    inscricao_municipal?: string;
    codigo_municipio: string;
  };
  tomador: NfseTomador;
  servico: NfseServico;
}

/** Resposta/callback do Focus (subset usado). */
export interface FocusNfseResponse {
  status?: string;
  numero?: string;
  codigo_verificacao?: string;
  url?: string;
  caminho_xml_nota_fiscal?: string;
  url_danfse?: string;
  erros?: Array<{ codigo?: string; mensagem?: string }>;
  mensagem?: string;
  ref?: string;
}

interface PrestadorConfig {
  cnpj: string;
  inscricaoMunicipal?: string;
  codigoMunicipio: string;
  optanteSimplesNacional: boolean;
  itemListaServico: string;
  aliquota?: number;
}

/**
 * item_lista_servico = "02684" e' o valor REAL usado pelas notas ja autorizadas em producao
 * pro mesmo CNPJ/inscricao municipal no `pster-finance` (confirmado direto no banco de producao,
 * 3 notas com numero/codigo_verificacao reais, nao homologacao) -- nao e' mais um placeholder
 * "razoavel", e' o valor que comprovadamente funciona pra essa inscricao especifica.
 * Overridable via env se um dia precisar mudar o item de servico.
 */
function prestadorFromEnv(): PrestadorConfig {
  const cnpj = process.env.PRESTADOR_CNPJ;
  const codigoMunicipio = process.env.PRESTADOR_CODIGO_MUNICIPIO;
  if (!cnpj || !codigoMunicipio) {
    throw new Error("PRESTADOR_CNPJ e PRESTADOR_CODIGO_MUNICIPIO precisam estar configurados no .env");
  }
  return {
    cnpj,
    inscricaoMunicipal: process.env.PRESTADOR_INSCRICAO_MUNICIPAL || undefined,
    codigoMunicipio,
    optanteSimplesNacional: process.env.PRESTADOR_OPTANTE_SIMPLES === "true",
    itemListaServico: process.env.PRESTADOR_ITEM_LISTA_SERVICO || "02684",
    // Sem default: as notas reais autorizadas em producao NAO enviam aliquota (o proprio
    // webservice/Focus calcula a partir do item_lista_servico cadastrado pra essa inscricao).
    // So envia se explicitamente configurado via env.
    aliquota: process.env.PRESTADOR_ALIQUOTA_ISS ? Number(process.env.PRESTADOR_ALIQUOTA_ISS) : undefined,
  };
}

export interface BuildNfsePayloadInput {
  tomador: BillingTomador;
  amountBrl: number;
  discriminacao: string;
  dataEmissao: Date;
}

/**
 * So envia leiaute 1 (sem campos de IBS/CBS da Reforma Tributaria) -- pster-finance (mesmo
 * CNPJ/inscricao municipal) confirma isso no proprio codigo: "Leave [usarLeiauteReforma] false
 * for Simples Nacional issuers -- Sao Paulo requires layout 1 (ISS only) for them"
 * (apps/backend/src/database/entities/payer.entity.ts).
 *
 * NAO envia regime_especial_tributacao nem aliquota -- confirmado direto no banco de PRODUCAO do
 * pster-finance (3 notas reais com status=autorizado, numero e codigo_verificacao presentes):
 * nenhuma delas manda esses dois campos. Uma tentativa anterior desta funcao mandava
 * regime_especial_tributacao="6" e um item_lista_servico diferente ("0105"), testado só contra o
 * ambiente de HOMOLOGACAO (que pode se comportar diferente da producao real durante a transicao
 * da Reforma Tributaria) -- foi substituido pela config que comprovadamente autoriza nota de
 * verdade.
 */
export function buildNfsePayload(input: BuildNfsePayloadInput): NfsePayload {
  const prestador = prestadorFromEnv();
  return {
    data_emissao: input.dataEmissao.toISOString(),
    natureza_operacao: "1",
    optante_simples_nacional: prestador.optanteSimplesNacional,
    prestador: {
      cnpj: prestador.cnpj,
      inscricao_municipal: prestador.inscricaoMunicipal,
      codigo_municipio: prestador.codigoMunicipio,
    },
    tomador: buildTomador(input.tomador),
    servico: {
      valor_servicos: input.amountBrl,
      base_calculo: input.amountBrl,
      iss_retido: false,
      item_lista_servico: prestador.itemListaServico,
      aliquota: prestador.aliquota,
      codigo_municipio: prestador.codigoMunicipio,
      discriminacao: input.discriminacao,
    },
  };
}

function buildTomador(tomador: BillingTomador): NfseTomador {
  const result: NfseTomador = {
    razao_social: tomador.razaoSocial,
    email: tomador.email,
    telefone: tomador.telefone,
    inscricao_municipal: tomador.inscricaoMunicipal,
  };
  if (tomador.cpf) {
    result.cpf = tomador.cpf;
  } else if (tomador.cnpj) {
    result.cnpj = tomador.cnpj;
  }
  if (tomador.endereco) {
    const a = tomador.endereco;
    result.endereco = {
      logradouro: a.logradouro,
      numero: a.numero,
      complemento: a.complemento,
      bairro: a.bairro,
      codigo_municipio: a.codigoMunicipio,
      uf: a.uf,
      cep: a.cep,
    };
  }
  return result;
}
