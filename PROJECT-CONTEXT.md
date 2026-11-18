# Project Context — Monitor NF-e Mercado Livre × SFTP

Base compartilhada para sessões de análise e planejamento. Dados de cliente (nome, conta, hosts, credenciais) **não** entram aqui — ficam no `.env` e no `monitoramento/config.yml`, fora do Git. Detalhes: [README.md](README.md) · [docs/](docs/README.md).

## Projeto e propósito

Detectar NF-e autorizada no Mercado Livre que ainda não chegou ao SFTP do cliente, apontar em que etapa da integração fiscal a nota parou (aviso do ML → gateway Nerus → envio FTP) e, quando o ML não notificou o gateway, disparar a contingência (renotificação). Objetivo de negócio: **identificar e agir antes do cliente perceber**.

## Stack

- **n8n** — agenda, esperas (Wait 2/10 min), orquestração do lote e notificações (Google Chat, e-mail, WhatsApp). Postgres é só do n8n.
- **monitor-sftp** — Node 22 + TypeScript, `http` nativo, sem framework. Lê SFTP (`ssh2-sftp-client`), relatório ZIP de NF-e do ML (OAuth com refresh de uso único), MySQL do gateway via túnel SSH (`ssh2` + `mysql2`).
- **Painel** — HTML único servido pelo monitor (`/painel`), checagem silenciosa a cada `PAINEL_INTERVALO_MIN`, histórico por dia em `data/historico/AAAAMMDD.json`.
- Docker Compose; produção em VPS com Traefik (monitor não exposto, acesso por túnel).
- Testes: `node:test` via `tsx` (`npm test`).

## Regra de negócio central

- Por série, o **teto** é a última NF autorizada no ZIP do ML do dia. Toda numeração de `nota_inicial` até o teto deve existir no FTP (inutilizações contam como presentes).
- Sem teto do ML (sem credencial, 429), a sequência usa só o máximo do FTP — furos no fim ficam invisíveis; isso é **cobertura degradada**, nunca "ok".
- Decisão por nota ausente: sem aviso do ML → contingência + admin; integrada e `SENT` → rechecar FTP; `PENDING`/`PROCESSING`/`RETRY_SCHEDULED` → esperar 10 min; `FAILED`/`SKIPPED`/`CANCELED` ou sem entrega → admin.

## Fase atual

Em produção para **1 cliente** (um container por cliente). Painel e histórico recém-criados. Regra de lote, espera e textos no monitor (`/ciclo`, ADR-004); workflow n8n sem nós Code (`workflows/monitor-sftp.json`), aguardando ativação em produção no lugar do workflow antigo.

## Restrições

- Sem segredos ou dados de cliente no Git.
- API do ML tem limite de taxa (429 observado) — `ML_TETO_CACHE_MIN` controla o reuso do ZIP.
- Contingência é ação real em produção; não há ambiente de homologação.
- Refresh token do ML é de uso único: perder a gravação = sem teto até intervenção manual.

## O que é "pronto"

- Furo detectado em ≤ 5 min, com etapa da falha e ação recomendada visíveis no painel e no aviso.
- Cobertura degradada (ML/SFTP/SSH indisponível) nunca aparece como verde — nem no painel nem no chat.
- Regra de decisão em código TypeScript testado; n8n só agenda, espera e notifica.
- Saúde diária registrada (furos, tempo até o FTP, falhas) e consultável por dia.
