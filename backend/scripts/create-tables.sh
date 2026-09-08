#!/usr/bin/env bash
# Cria as 6 tabelas do LicitaHawk no DynamoDB. Idempotente: se a tabela ja existir, avisa e continua
# (script reaproveitado na Fase 7 contra a AWS real, so trocando o valor de DYNAMODB_ENDPOINT).
set -euo pipefail

# cd (em vez de resolver um path absoluto com pwd) porque o aws-cli no Windows nao entende paths
# estilo /c/... do Git Bash em --cli-input-json file://; paths relativos funcionam nos dois.
cd "$(dirname "${BASH_SOURCE[0]}")"
TABLE_DEFS_DIR="table-defs"
REGION="${AWS_REGION:-us-east-1}"

ENDPOINT_ARGS=()
if [ -n "${DYNAMODB_ENDPOINT:-}" ]; then
  ENDPOINT_ARGS=(--endpoint-url "$DYNAMODB_ENDPOINT")
  echo "Usando DynamoDB endpoint local: $DYNAMODB_ENDPOINT"
else
  echo "DYNAMODB_ENDPOINT nao setado -- usando o endpoint real da AWS ($REGION)"
fi

for def_file in "$TABLE_DEFS_DIR"/*.json; do
  table_name="$(grep -o '"TableName"[[:space:]]*:[[:space:]]*"[^"]*"' "$def_file" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  echo "=== Criando tabela: $table_name ==="
  if aws dynamodb create-table \
      "${ENDPOINT_ARGS[@]}" \
      --region "$REGION" \
      --cli-input-json "file://$def_file" \
      >/dev/null 2>&1; then
    echo "OK: $table_name criada."
  else
    if aws dynamodb describe-table "${ENDPOINT_ARGS[@]}" --region "$REGION" --table-name "$table_name" >/dev/null 2>&1; then
      echo "SKIP: $table_name ja existe."
    else
      echo "ERRO: falha ao criar $table_name (e nao existe previamente)." >&2
      exit 1
    fi
  fi
done

echo "=== Habilitando TTL na tabela RateLimitEvents (campo 'ttl', retencao de 14 dias) ==="
if aws dynamodb update-time-to-live \
    "${ENDPOINT_ARGS[@]}" \
    --region "$REGION" \
    --table-name RateLimitEvents \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" \
    >/dev/null 2>&1; then
  echo "OK: TTL habilitado em RateLimitEvents."
else
  echo "SKIP: TTL ja habilitado em RateLimitEvents (ou tabela recem-criada aguardando propagacao -- reexecute o script se for a primeira vez)."
fi

echo "=== Habilitando TTL na tabela ClientRateLimits (campo 'ttl', janela de rate limit por cliente) ==="
if aws dynamodb update-time-to-live \
    "${ENDPOINT_ARGS[@]}" \
    --region "$REGION" \
    --table-name ClientRateLimits \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" \
    >/dev/null 2>&1; then
  echo "OK: TTL habilitado em ClientRateLimits."
else
  echo "SKIP: TTL ja habilitado em ClientRateLimits (ou tabela recem-criada aguardando propagacao -- reexecute o script se for a primeira vez)."
fi

echo "=== Habilitando TTL na tabela UsageDaily (campo 'ttl', retencao de 60 dias) ==="
if aws dynamodb update-time-to-live \
    "${ENDPOINT_ARGS[@]}" \
    --region "$REGION" \
    --table-name UsageDaily \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" \
    >/dev/null 2>&1; then
  echo "OK: TTL habilitado em UsageDaily."
else
  echo "SKIP: TTL ja habilitado em UsageDaily (ou tabela recem-criada aguardando propagacao -- reexecute o script se for a primeira vez)."
fi

echo "=== Garantindo GSI-customer-id em ApiKeys (idempotente -- create-table so roda pra tabela nova) ==="
if aws dynamodb update-table \
    "${ENDPOINT_ARGS[@]}" \
    --region "$REGION" \
    --table-name ApiKeys \
    --attribute-definitions AttributeName=customer_id,AttributeType=S \
    --global-secondary-index-updates '[{"Create":{"IndexName":"GSI-customer-id","KeySchema":[{"AttributeName":"customer_id","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}}]' \
    >/dev/null 2>&1; then
  echo "OK: GSI-customer-id criada em ApiKeys."
else
  echo "SKIP: GSI-customer-id ja existe em ApiKeys (ou tabela recem-criada ja nasceu com ela)."
fi

echo "=== Garantindo GSI4-uf_modalidade-data_publicacao em Tenders (idempotente) ==="
# Indice da busca combinada uf+modalidade (chave sintetica 'uf_modalidade', ver
# src/tenders/uf-modalidade-key.ts). Projection INCLUDE em vez de ALL de proposito: raw_payload
# (o payload cru do PNCP, dezenas de KB por item) fica FORA -- nenhuma rota de lista devolve esse
# campo, e projeta-lo aqui multiplicaria o armazenamento do indice sem nenhum leitor.
# ATENCAO: depois de criar a GSI numa tabela que ja tem dados, rode `npm run backfill-uf-modalidade`
# -- itens gravados antes desta versao nao tem o atributo e por isso NAO entram no indice sozinhos.
if aws dynamodb update-table \
    "${ENDPOINT_ARGS[@]}" \
    --region "$REGION" \
    --table-name Tenders \
    --attribute-definitions AttributeName=uf_modalidade,AttributeType=S AttributeName=data_publicacao,AttributeType=S \
    --global-secondary-index-updates '[{"Create":{"IndexName":"GSI4-uf_modalidade-data_publicacao","KeySchema":[{"AttributeName":"uf_modalidade","KeyType":"HASH"},{"AttributeName":"data_publicacao","KeyType":"RANGE"}],"Projection":{"ProjectionType":"INCLUDE","NonKeyAttributes":["org_cnpj","org_name","uf","municipio","modalidade","objeto","valor_estimado","data_atualizacao","situacao","link_pncp","keywords_tokenized"]}}}]' \
    >/dev/null 2>&1; then
  echo "OK: GSI4-uf_modalidade-data_publicacao criada em Tenders. Rode 'npm run backfill-uf-modalidade' se a tabela ja tinha dados."
else
  echo "SKIP: GSI4-uf_modalidade-data_publicacao ja existe em Tenders (ou tabela recem-criada ja nasceu com ela)."
fi

echo "=== Concluido. Tabelas atuais: ==="
aws dynamodb list-tables "${ENDPOINT_ARGS[@]}" --region "$REGION"
