# Termos de Serviço — LicitaHawk

**Última atualização:** [preencher na publicação]
**Status:** rascunho para revisão. Não é aconselhamento jurídico. Revisar com advogado antes de publicar para o primeiro cliente pagante.

---

## 1. Definições

- **"LicitaHawk"**, **"nós"**: a pessoa jurídica operadora do serviço, CNPJ [preencher].
- **"Cliente"**, **"você"**: pessoa física ou jurídica que contrata o Serviço.
- **"Serviço"**: a API REST e o servidor MCP oferecidos pela LicitaHawk para busca, consulta e alerta de licitações públicas brasileiras.
- **"Fonte Oficial"**: o Portal Nacional de Contratações Públicas (PNCP), mantido pelo governo federal, e sua API de consulta pública.
- **"Filtro Salvo"**: configuração de busca recorrente cadastrada pelo Cliente para geração de alertas via webhook.

## 2. Objeto

2.1. O Serviço consiste em normalizar, indexar e disponibilizar, via API e via servidor MCP, dados de licitações públicas obtidos exclusivamente da Fonte Oficial.

2.2. O Serviço não participa, media ou interfere em processos licitatórios. Toda decisão de participação, proposta ou lance é de responsabilidade exclusiva do Cliente.

2.3. O Serviço não substitui assessoria jurídica, contábil ou de consultoria em licitações. As informações fornecidas têm caráter informativo.

## 3. Cadastro, conta e chave de API

3.1. O acesso ao Serviço é feito mediante chave de API (API key) pessoal e intransferível, vinculada ao Cliente.

3.2. O Cliente é responsável por manter sua chave de API em sigilo. Qualquer uso feito com a chave é presumido de responsabilidade do Cliente até que a revogação seja solicitada e efetivada.

3.3. É proibido compartilhar, revender ou sublicenciar o acesso à API sem autorização expressa e por escrito da LicitaHawk.

## 4. Planos, cobrança e cancelamento

4.1. O Serviço é oferecido em planos com limites de uso mensal (quantidade de requisições e de Filtros Salvos), conforme descrito na página de preços vigente no momento da contratação.

4.2. A cobrança é processada por gateway de pagamento terceirizado (Asaas). A LicitaHawk não armazena dados completos de cartão de crédito.

4.3. Assinaturas são recorrentes e renovadas automaticamente, salvo cancelamento pelo Cliente antes da data de renovação, através do painel do Cliente ou por solicitação por e-mail.

4.4. Não há reembolso proporcional por cancelamento no meio do ciclo de cobrança, exceto quando exigido por lei.

4.5. Emissão de nota fiscal (NFS-e) é feita para cada cobrança processada com sucesso, via integração com prestador de emissão fiscal (Focus NFe). O Cliente é responsável por manter seus dados cadastrais (razão social, CNPJ/CPF, endereço, inscrição municipal quando aplicável) atualizados e corretos para fins de emissão.

4.6. Quando o Cliente, na condição de tomador de serviço pessoa jurídica, estiver sujeito a retenção de ISS na fonte por força de legislação municipal, a responsabilidade pelo correto recolhimento e informação dessa retenção é do Cliente. A LicitaHawk poderá, mediante solicitação, ajustar o valor da nota fiscal para refletir a retenção informada.

## 5. Disponibilidade e limitação de responsabilidade sobre a Fonte Oficial

5.1. Os dados exibidos pelo Serviço têm origem exclusiva na Fonte Oficial. A LicitaHawk não controla a disponibilidade, a exatidão, a completude ou a tempestividade dos dados publicados pela Fonte Oficial.

5.2. **A LicitaHawk não garante que todo edital publicado na Fonte Oficial será capturado, normalizado ou notificado dentro de um prazo determinado.** Atrasos, omissões ou indisponibilidades causados por instabilidade, mudança de formato, manutenção ou qualquer outra condição da Fonte Oficial, alheia ao controle da LicitaHawk, não geram direito a crédito, desconto, indenização ou reembolso automático.

5.3. O Cliente reconhece que o Serviço é uma camada de conveniência sobre dado público, e que a Fonte Oficial permanece a referência de veracidade em caso de qualquer divergência.

5.4. A LicitaHawk envidará esforços razoáveis para manter o Serviço disponível e a ingestão de dados atualizada, mas não presta garantia de SLA (nível de serviço) no plano gratuito ou nos planos de entrada, salvo se contratado expressamente um plano com SLA.

## 6. Webhooks e alertas

6.1. Cada notificação de webhook é assinada digitalmente (HMAC) e acompanhada de um identificador de idempotência, para permitir que o Cliente valide a autenticidade e evite processamento duplicado.

6.2. É responsabilidade do Cliente manter o endpoint de recebimento de webhook disponível, seguro e capaz de responder dentro do tempo limite estabelecido pela LicitaHawk.

6.3. Após um número consecutivo de falhas de entrega, a LicitaHawk poderá desativar automaticamente o Filtro Salvo correspondente, notificando o Cliente por e-mail. A reativação é de responsabilidade do Cliente.

## 7. Uso aceitável

7.1. É vedado: (a) tentar burlar limites de requisição contratados; (b) realizar engenharia reversa do Serviço com o intuito de reproduzir sua funcionalidade central; (c) utilizar o Serviço para fins ilícitos; (d) sobrecarregar deliberadamente a infraestrutura do Serviço.

7.2. A LicitaHawk poderá suspender ou encerrar o acesso do Cliente em caso de violação destes Termos, mediante notificação prévia, exceto em casos de uso abusivo que exijam ação imediata.

## 8. Propriedade intelectual

8.1. Os dados brutos de licitação são de natureza pública e não são objeto de propriedade da LicitaHawk.

8.2. A normalização, estruturação, indexação, camada de busca, e o software que compõe o Serviço (API, servidor MCP, infraestrutura) são de propriedade da LicitaHawk.

8.3. A marca "LicitaHawk" e elementos visuais associados são de propriedade da LicitaHawk.

## 9. Privacidade e dados pessoais

9.1. O tratamento de dados pessoais do Cliente segue a Política de Privacidade vigente, elaborada em conformidade com a Lei Geral de Proteção de Dados (LGPD, Lei 13.709/2018). [Vincular política de privacidade separada antes da publicação.]

## 10. Limitação de responsabilidade

10.1. Na máxima extensão permitida pela legislação aplicável, a responsabilidade total da LicitaHawk perante o Cliente, por qualquer reclamação decorrente do uso do Serviço, está limitada ao valor pago pelo Cliente nos 3 (três) meses anteriores ao evento gerador.

10.2. A LicitaHawk não se responsabiliza por perdas e danos decorrentes de decisões de negócio tomadas pelo Cliente com base nas informações fornecidas pelo Serviço, incluindo, sem limitação, decisão de participar ou não de uma licitação.

## 11. Alterações destes Termos

11.1. A LicitaHawk poderá alterar estes Termos a qualquer momento, publicando a versão atualizada com nova data de vigência. O uso continuado do Serviço após a alteração implica concordância com os novos termos.

## 12. Legislação aplicável e foro

12.1. Estes Termos são regidos pelas leis da República Federativa do Brasil.

12.2. Fica eleito o foro da comarca de [preencher cidade/sede da empresa] para dirimir quaisquer controvérsias decorrentes destes Termos, com renúncia a qualquer outro, por mais privilegiado que seja.

## 13. Contato

Dúvidas sobre estes Termos: [e-mail de suporte, preencher].

---

### Pendências antes de publicar
- [ ] Preencher CNPJ, cidade/foro, e-mail de contato.
- [ ] Vincular Política de Privacidade (LGPD) — documento separado, ainda não escrito.
- [ ] Revisão por advogado, principalmente cláusulas 5 (isenção por indisponibilidade da Fonte Oficial), 10 (limitação de responsabilidade) e 4.6 (retenção de ISS).
- [ ] Confirmar se o plano gratuito exige aceite explícito destes Termos no cadastro (checkbox), não só link no rodapé.
