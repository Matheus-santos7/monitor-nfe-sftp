# Monitor NF-e SFTP

Detecta NF-e autorizada no Mercado Livre que ainda não chegou ao SFTP, aponta em qual etapa da integração fiscal a nota parou e, quando o marketplace nunca notificou o gateway, dispara a contingência.

O n8n agenda e notifica. Um serviço Node (`monitor-sftp`) consulta o SFTP, o relatório ZIP do Mercado Livre e o MySQL do gateway (via SSH).

## O que ele faz

1. Lista os XMLs no SFTP e baixa o relatório fiscal do Mercado Livre (ZIP do dia).
2. Usa a **última NF autorizada de cada série** como teto da sequência — não o último arquivo do FTP.
3. Se faltar número: localiza o `invoice_id` no ZIP, consulta o gateway (notificação → invoice → entrega FTP) e monta um relatório passo a passo.
4. Se o Mercado Livre não notificou o gateway, simula o payload de `invoices` (contingência), espera no n8n e reconsulta.

Detalhe do fluxo: [docs/fluxo.md](docs/fluxo.md) · HTTP: [docs/api.md](docs/api.md) · decisões: [docs/decisions/](docs/decisions/).

## Stack

| Peça | Papel |
|---|---|
| n8n | Agenda (seg–sex 8h/12h/15h/17h, America/Sao_Paulo), Wait, Chat / e-mail / WhatsApp |
| monitor-sftp | SFTP, OAuth ML, ZIP de NF-e, SSH → MySQL, contingência |
| PostgreSQL | Banco **do n8n** (não é o banco fiscal) |

```
n8n
  ├─ POST /executar            SFTP + teto ML + furos
  ├─ GET  /ml/me               renova OAuth e valida o seller
  ├─ GET  /ml/invoice          invoice_id pela NF/série (ZIP)
  ├─ POST /diagnostico         MySQL do gateway + contingência
  └─ POST /diagnostico/entrega reconsulta entrega FTP
        │
        ▼
  monitor-sftp
        ├─ SFTP (XML)
        ├─ api.mercadolibre.com (ZIP batch_request)
        └─ SSH → MySQL (notification_control, invoice, fiscal_document_deliveries)
```

## Subir localmente

```bash
cp .env.example .env          # preencha segredos — nunca commite
cp monitoramento/config.example.yml monitoramento/config.yml
# coloque a chave SSH do bastion em secrets/bastion.pem (chmod 600)

docker compose up -d --build
```

| Serviço | URL |
|---|---|
| n8n | http://localhost:5678 |
| Monitor (host) | http://localhost:8081 |
| Monitor (rede Docker) | http://monitor-sftp:8080 |

Importar os workflows:

```bash
docker compose run --rm --no-deps n8n import:workflow --input=/files/workflows/monitor-sftp.json
docker compose run --rm --no-deps n8n import:workflow --input=/files/workflows/error-handler.json
```

Não use `docker exec n8n n8n import:workflow` — sobe um segundo processo no mesmo container.

No editor, ative **1. Monitor SFTP NF-e**. Em Settings → Error workflow, selecione **0. Error Handler — Monitor NF-e**. O monitor não tem cron interno (`agendamento` vazio no `config.yml`).

## Comandos

| Comando | Efeito |
|---|---|
| `docker compose up` | Sobe o stack; o log mostra só os passos do fluxo |
| `docker compose up -d --build monitor-sftp` | Rebuild do monitor |
| `curl -X POST http://127.0.0.1:8081/executar?notify=false` | Checagem SFTP + teto ML, sem webhook |
| `cd monitoramento && npm test` | Testes do monitor |

Produção (VPS): overlay Traefik em `docker-compose.prod.yml`. Bind HTTP em `0.0.0.0:$PORT`. Disco do container é efêmero — não grave XML local.

## Configuração

Tudo que identifica o cliente fica no `.env` e no `config.yml` (ambos fora do Git). O `.env.example` e o `config.example.yml` usam só valores fictícios.

| Variável | Uso |
|---|---|
| `ML_CLIENT_ID` / `ML_CLIENT_SECRET` / `ML_REFRESH_TOKEN` | OAuth ML; o access token dura ~6 h e o refresh gira a cada renovação |
| `ML_USER_ID` | Seller do relatório fiscal |
| `NERUS_*` | SSH, MySQL e API do gateway (diagnóstico e contingência) |
| `MONITOR_HTTP_TOKEN` | Bearer entre n8n e o monitor |
| `FAKE_NOTA` | Ex.: `1000/1` força um furo de teste; vazio em produção |

Depois de mudar o `.env`: `docker compose up -d --force-recreate monitor-sftp n8n`.

## Limites conhecidos

- `GET /users/{id}/invoices/search` retorna 403. O `invoice_id` sai do ZIP (`{invoice_id}_{chave}-procNFe.xml`).
- Sem token ML (ou sem emissão no dia), o teto cai no máximo do FTP — furos no fim da sequência ficam invisíveis.
- Esperas de 2 min (contingência) e 10 min (entrega pending) são nós Wait do n8n, não o HTTP do monitor.
- Postgres do n8n não é publicado na 5432 do host.
