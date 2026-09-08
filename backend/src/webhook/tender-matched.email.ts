import { TenderMatchedPayload } from "../common/ports/alert-queue-port";

/**
 * Renderiza o email de "licitacao casou com o seu alerta". Recebe exatamente o mesmo payload que
 * o webhook posta, entao os dois canais nunca divergem no conteudo -- muda o transporte, nao a
 * informacao.
 *
 * HTML de email: estilo inline e tabela simples de proposito (cliente de email ignora <style> e
 * grid/flex). Todo dado do PNCP passa por escapeHtml antes de entrar no HTML: e' texto de terceiro
 * chegando por ingestao, e um `objeto` com "<" nao pode virar markup no cliente de email de quem
 * assinou o alerta.
 */

const NAVY = "#0f1d33";
const GOLD = "#c9a227";
const TEXT = "#1f2933";
const MUTED = "#5b6672";
const BORDER = "#e3e7ec";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderTenderMatchedEmail(payload: TenderMatchedPayload): RenderedEmail {
  const { tender } = payload;
  const prefix = payload.test ? "[Teste] " : "";
  const subject = `${prefix}Nova licitacao em ${tender.uf}: ${truncate(tender.objeto, 80)}`;

  const rows: [string, string][] = [
    ["Orgao", tender.org_name],
    ["CNPJ", formatCnpj(tender.org_cnpj)],
    ["UF", tender.uf],
    ["Modalidade", tender.modalidade],
    ["Valor estimado", formatBrl(tender.valor_estimado)],
    ["Numero de controle PNCP", tender.pncp_control_number],
  ];

  return { subject, html: renderHtml(payload, rows), text: renderText(payload, rows) };
}

function renderHtml(payload: TenderMatchedPayload, rows: [string, string][]): string {
  const { tender } = payload;
  const testBanner = payload.test
    ? `<p style="margin:0 0 16px;padding:10px 12px;border-radius:6px;background:#fff8e1;color:#7a5c00;font-size:13px;">
         Este e um <strong>disparo de teste</strong> pedido por voce no painel. Nenhuma licitacao real casou com o alerta.
       </p>`
    : "";

  const rowsHtml = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:6px 0;color:${MUTED};font-size:13px;white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="padding:6px 0 6px 16px;color:${TEXT};font-size:13px;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join("");

  return `<div style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
    <div style="padding:16px 24px;background:${NAVY};">
      <span style="color:${GOLD};font-size:15px;font-weight:700;letter-spacing:0.02em;">LicitaHawk</span>
    </div>
    <div style="padding:24px;">
      ${testBanner}
      <p style="margin:0 0 4px;color:${MUTED};font-size:12px;text-transform:uppercase;letter-spacing:0.08em;">Alerta disparado</p>
      <h1 style="margin:0 0 16px;color:${TEXT};font-size:18px;line-height:1.4;font-weight:600;">${escapeHtml(tender.objeto)}</h1>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid ${BORDER};margin-bottom:20px;">
        ${rowsHtml}
      </table>
      <a href="${escapeAttr(tender.link_pncp)}" style="display:inline-block;padding:10px 18px;background:${GOLD};color:${NAVY};font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">Ver no PNCP</a>
    </div>
    <div style="padding:16px 24px;background:#fafbfc;border-top:1px solid ${BORDER};color:${MUTED};font-size:12px;line-height:1.5;">
      Voce recebeu este email porque tem um alerta ativo no LicitaHawk para ${escapeHtml(tender.uf)} / ${escapeHtml(tender.modalidade)}.
      Para parar de receber, desative ou exclua o alerta no painel.
    </div>
  </div>
</div>`;
}

function renderText(payload: TenderMatchedPayload, rows: [string, string][]): string {
  const { tender } = payload;
  const lines = [
    payload.test ? "[Teste] Disparo de teste pedido por voce no painel.\n" : "",
    "LicitaHawk -- alerta disparado",
    "",
    tender.objeto,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    `Ver no PNCP: ${tender.link_pncp}`,
    "",
    "Voce recebeu este email porque tem um alerta ativo no LicitaHawk. Para parar de receber, desative ou exclua o alerta no painel.",
  ];
  return lines.filter((line, i) => !(i === 0 && line === "")).join("\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}...`;
}

function formatBrl(value: number | null): string {
  if (value === null) return "nao informado";
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatCnpj(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 14) return raw;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Atributo href: alem do escape de HTML, so deixa passar http(s). `link_pncp` vem da ingestao do
 * PNCP; um valor inesperado com `javascript:` nao pode virar link clicavel no cliente de email.
 */
function escapeAttr(url: string): string {
  const safe = /^https?:\/\//i.test(url) ? url : "https://pncp.gov.br";
  return escapeHtml(safe);
}
