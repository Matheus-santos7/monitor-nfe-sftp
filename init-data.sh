#!/bin/bash
set -e

# Roda só na primeira inicialização do volume do Postgres.
# Cria o usuário de aplicação (não-root) e o schema isolado do n8n.

if [ -n "${POSTGRES_NON_ROOT_USER:-}" ] && [ -n "${POSTGRES_NON_ROOT_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER ${POSTGRES_NON_ROOT_USER} WITH PASSWORD '${POSTGRES_NON_ROOT_PASSWORD}';
    GRANT ALL PRIVILEGES ON DATABASE ${POSTGRES_DB} TO ${POSTGRES_NON_ROOT_USER};
    GRANT CREATE ON SCHEMA public TO ${POSTGRES_NON_ROOT_USER};
    CREATE SCHEMA IF NOT EXISTS n8n AUTHORIZATION ${POSTGRES_NON_ROOT_USER};
    GRANT ALL ON SCHEMA n8n TO ${POSTGRES_NON_ROOT_USER};
  EOSQL
else
  echo "SETUP INFO: POSTGRES_NON_ROOT_USER / POSTGRES_NON_ROOT_PASSWORD não definidos."
fi
