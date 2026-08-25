# ADR-003: Diagnóstico Nerus via SSH + MySQL

## Status

Accepted

## Date

2026-08-24

## Context

Com o `invoice_id` em mãos, precisávamos ver se o ML notificou o gateway, se a nota entrou em `nerus_o2.invoice` e se o XML foi para o FTP (`fiscal_document_deliveries`).

O banco fiscal é **MySQL 8** acessado por túnel SSH (usuário + PEM do bastion → porta 3306). Não confundir com o Postgres do n8n.

Esperas de 2 min (após contingência) e 10 min (entrega pending) não cabem bem num HTTP único: o n8n tem nós Wait e o monitor só consulta/renotifica.

## Decision

- O serviço `monitor-sftp` abre SSH (`ssh2`) e encaminha MySQL (`mysql2`) com queries parametrizadas.
- SSL do RDS desligado para espelhar o DBeaver (`ssl.require=false`).
- Contingência: signin HTTP + `POST /notification/invoice?clientId={tenant}` simulando o feed `invoices`.
- n8n orquestra Wait → `GET /diagnostico/entrega` → recheck SFTP → relatório.

## Alternatives considered

### SQL no n8n (SSH tunnel node)

- Prós: menos código no monitor.
- Contras: credenciais e PEM espalhados; lógica de decisão duplicada.
- Rejeitado nesta fase.

### Esperar 10 min dentro do `/diagnostico`

- Prós: um request.
- Contras: timeout, worker preso, retry difícil.
- Rejeitado.

## Consequences

- Sem `NERUS_DB_USER` / `NERUS_DB_PASSWORD` o diagnóstico falha (preencher pelo DBeaver).
- PEM montado em `/run/secrets/bastion.pem`; path no host via `NERUS_SSH_KEY_HOST_PATH`.
- Senha de signin e JWT não devem ir para o git nem para o chat. Rotacionar se vazarem.
- Relatório sempre lista os passos, mesmo quando a contingência não roda.
