import { emailService } from "../src/email/email.instance";

// Utilitario de dev: manda um email pelo provider configurado em EMAIL_PROVIDER. Uso:
//   npx tsx scripts/send-test-email.ts <destinatario> ["Assunto"]
// Com EMAIL_PROVIDER ausente ou "console" nada sai de verdade -- so imprime o payload. Com
// EMAIL_PROVIDER=zeptomail o envio e' real e conta na cota da conta do ZeptoMail.
async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error("uso: npx tsx scripts/send-test-email.ts <destinatario> [assunto]");
    process.exit(1);
  }
  const subject = process.argv[3] ?? "LicitaHawk -- email de teste";

  console.log(`Enviando via provider "${emailService.providerName}" para ${to}...`);
  const result = await emailService.send({
    to: [{ address: to }],
    subject,
    html: "<div><b>Email de teste do LicitaHawk.</b></div><p>Se voce recebeu isto, o connector esta funcionando.</p>",
    text: "Email de teste do LicitaHawk. Se voce recebeu isto, o connector esta funcionando.",
    clientReference: "send-test-email-script",
  });

  console.log("Enviado:", JSON.stringify(result));
}

main().catch((error) => {
  console.error("Falhou:", error);
  process.exit(1);
});
