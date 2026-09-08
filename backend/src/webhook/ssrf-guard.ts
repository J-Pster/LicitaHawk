import { promises as dns } from "node:dns";
import { URL } from "node:url";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

interface CidrRange {
  base: number;
  bits: number;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function parseCidr(cidr: string): CidrRange {
  const [ip, bitsStr] = cidr.split("/");
  const base = ipv4ToInt(ip);
  if (base === null) throw new Error(`CIDR invalido: ${cidr}`);
  return { base, bits: Number(bitsStr) };
}

// Ranges exigidos pelo plano (Fase 4.2). 169.254.0.0/16 inclui 169.254.169.254 (endpoint de
// credenciais do runtime AWS) -- bloqueio critico, nao e so link-local generico.
// 0.0.0.0/8 e 100.64.0.0/10 (CGNAT, hospeda metadata service da Alibaba Cloud 100.100.100.200 e
// ranges internos de load balancer) adicionados na revisao de seguranca pos-implementacao.
const BLOCKED_IPV4_RANGES: CidrRange[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "127.0.0.0/8",
].map(parseCidr);

function isIpv4Blocked(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return BLOCKED_IPV4_RANGES.some(({ base, bits }) => {
    const mask = bits <= 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  });
}

// Primeiro hextet (16 bits) do endereco -- suficiente pra checar os ranges fc00::/7 e fe80::/10
// abaixo, que sao definidos pelos bits mais altos. "::1" e enderecos comecando com "::" tem
// primeiro hextet 0 (zeros comprimidos).
function firstHextet(ip: string): number {
  const withoutZone = ip.split("%")[0];
  if (withoutZone.startsWith("::")) return 0;
  return parseInt(withoutZone.split(":")[0] || "0", 16) || 0;
}

// loopback ::1, mapeamento IPv4-in-IPv6 (::ffff:a.b.c.d, bypass classico de filtro so-IPv4),
// fc00::/7 (Unique Local Address -- equivalente IPv6 do RFC1918, inclui o metadata IPv6 da AWS
// fd00:ec2::254) e fe80::/10 (link-local). Achado real da revisao de seguranca: as duas ultimas
// faixas nao estavam cobertas, deixando aberto o mesmo tipo de bypass que o bloqueio de
// 169.254.169.254 (IPv4) ja fechava.
function isIpv6Blocked(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isIpv4Blocked(mapped[1]);
  const first = firstHextet(lower);
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 (ULA)
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 (link-local)
  return false;
}

export function isBlockedIp(ip: string, family: 4 | 6): boolean {
  return family === 4 ? isIpv4Blocked(ip) : isIpv6Blocked(ip);
}

export interface SafeResolution {
  hostname: string;
  ip: string;
  family: 4 | 6;
}

/**
 * Resolve o hostname da URL do webhook e garante que NENHUM IP retornado cai em range privado,
 * link-local ou loopback. Deve ser chamada de novo a cada disparo (nunca cacheada) e o IP retornado
 * aqui deve ser usado diretamente na conexao HTTP (sem um segundo lookup) -- e a mitigacao de DNS
 * rebinding: resolver, validar e conectar no mesmo IP, num unico passo.
 */
export async function resolveAndAssertSafe(rawUrl: string): Promise<SafeResolution> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("URL invalida");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(`Protocolo nao permitido: ${parsed.protocol}`);
  }

  let lookups: { address: string; family: number }[];
  try {
    lookups = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new SsrfBlockedError(`Falha ao resolver hostname: ${(err as Error).message}`);
  }
  if (lookups.length === 0) {
    throw new SsrfBlockedError("Hostname nao resolveu para nenhum IP");
  }

  for (const { address, family } of lookups) {
    if (isBlockedIp(address, family as 4 | 6)) {
      throw new SsrfBlockedError(
        `IP resolvido bloqueado (range privado/link-local/loopback): ${address}`,
      );
    }
  }

  const chosen = lookups[0];
  return { hostname: parsed.hostname, ip: chosen.address, family: chosen.family as 4 | 6 };
}
