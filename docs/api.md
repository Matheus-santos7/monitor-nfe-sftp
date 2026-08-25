# API do monitor (`monitor-sftp`)

Host local: `http://127.0.0.1:8081` (container escuta `0.0.0.0:8080`).  
Rede Docker (n8n): `http://monitor-sftp:8080`.

Autenticação: `MONITOR_HTTP_TOKEN` no `.env` (preferido) ou `http.token` em `config.yml`. Envie `Authorization: Bearer {token}` ou `X-Token`. Evite `?token=` (aparece em logs de proxy). Sem token configurado, os endpoints ficam abertos na rede Docker.

Timeouts no n8n para `/executar` e `/diagnostico` devem ser altos (ZIP do ML + SFTP + SSH). O compose usa 180 s.

## `GET /health`

```json
{ "ok": true, "ocupado": false }
```

## `POST /executar` · `GET /executar`

Checagem SFTP + teto ML. `?notify=false` não dispara os webhooks do `config.yml` (o n8n notifica por conta própria).

`409` se já houver job em andamento.

Resposta (campos relevantes):

| Campo | Significado |
|---|---|
| `series[].max` | Último número **no FTP** |
| `series[].tetoMl` | Último número **autorizado no ML** na janela |
| `series[].ultimaMlNoFtp` | `true` se o teto está no FTP; `false` se falta; `null` se o teto não foi consultado |
| `series[].pulos` | Furos de `nota_inicial` até o teto |
| `notasAusentes` | Lista expandida (limite 40) |
| `integracaoOk` | Sem furos (e sem `FAKE_NOTA`) |
| `tetoPeriodo` | `{ start, end }` `AAAAMMDD` |

## `GET /ml/me`

Renova o access token (se estiver expirado) e chama `GET /users/me`.

```json
{ "ok": true, "id": 1000000000 }
```

## `GET /ml/teto`

Últimas NFs autorizadas por série no ZIP.

Query: `start`, `end` (`AAAAMMDD`), `series=2,8`.

Sem `start`/`end`, usa `ML_TETO_DIAS` (padrão **1** = só hoje).

```bash
curl http://127.0.0.1:8081/ml/teto
```

## `GET /ml/invoice`

Localiza `invoice_id` + chave pela NF/série no mesmo ZIP (hoje → 7 dias → mês).

```bash
curl "http://127.0.0.1:8081/ml/invoice?numero=1000&serie=1"
```

Não existe `GET /invoices/search` utilizável nesta app (403 PolicyAgent). Ver [ADR-001](decisions/0001-relatorio-zip-em-vez-de-search.md).

## `POST /diagnostico`

Body JSON:

```json
{
  "invoiceId": "1000000001",
  "chave": "35260800000000000191…",
  "numero": 1000,
  "serie": 1,
  "mlUserId": "1000000000",
  "executarContigencia": true
}
```

`executarContigencia` default `true`; só dispara se **não** houver notificação no gateway.

A espera de 2/10 min **não** ocorre neste handler — o n8n usa nós Wait e depois `POST /diagnostico/entrega`.

## `POST /diagnostico/entrega` · `GET /diagnostico/entrega`

Reconsulta invoice + `fiscal_document_deliveries`. Prefira **POST** (chave NF-e não vai na query string / access log).

```json
{
  "invoiceId": "1000000001",
  "chave": "35260800000000000191…",
  "mlUserId": "1000000000"
}
```

GET ainda funciona para debug local; não use a chave na URL em produção.
