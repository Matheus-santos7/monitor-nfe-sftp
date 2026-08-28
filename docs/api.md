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
| `notasAusentes` | Lista completa dos números ausentes no FTP |
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

`executarContigencia` default `true`; só dispara se **não** houver notificação no gateway. Se alguma consulta SQL falhar, a contingência **não** dispara: o relatório traz o rastro com `ERRO:` na tabela que quebrou.

A espera de 2/10 min **não** ocorre neste handler — o n8n usa nós Wait e depois `POST /diagnostico/entrega`. A resposta inclui `rastro` (tabela, filtro, linhas, ids, status).

A resposta também traz `diagnosticoId`: o UUID da linha gravada em `monitor.diagnosticos`. É `null` quando o histórico está desligado (sem `MONITOR_DB_HOST`) ou quando a gravação falhou — o diagnóstico em si não é afetado. Guarde esse id e devolva em `/diagnostico/entrega` para fechar o caso no histórico.

## `POST /diagnostico/entrega` · `GET /diagnostico/entrega`

Reconsulta invoice + `fiscal_document_deliveries`. Prefira **POST** (chave NF-e não vai na query string / access log).

```json
{
  "invoiceId": "1000000001",
  "chave": "35260800000000000191…",
  "mlUserId": "1000000000",
  "diagnosticoId": "9f1c…"
}
```

`diagnosticoId` é opcional. Quando vem, o mesmo registro do `POST /diagnostico` é **atualizado** (não cria uma segunda linha) com o desfecho: `resolvido`, `em_andamento` ou `precisa_atencao`. Sem ele, a rota se comporta como antes — útil para debug avulso. No GET, passe como querystring.

GET ainda funciona para debug local; não use a chave na URL em produção.

## `GET /historico`

Agregados das execuções e diagnósticos gravados em Postgres (schema `monitor`, ver [ADR-004](decisions/0004-historico-no-postgres-do-n8n.md)).

Query: `dias` (padrão **7**).

`503` quando o histórico está desligado (`MONITOR_DB_HOST` vazio).

```bash
curl "http://127.0.0.1:8081/historico?dias=7"
```

```json
{
  "ok": true,
  "periodo": { "dias": 7, "desde": "2026-08-21", "ate": "2026-08-28" },
  "execucoes": { "total": 56, "comFuro": 3, "integracaoOkPct": 94.6 },
  "diagnosticos": { "total": 5, "resolvidos": 4, "precisaAtencao": 1 },
  "serieMaisAfetada": { "serie": 2, "totalAusentesSomado": 7 }
}
```

| Campo | Significado |
|---|---|
| `execucoes.comFuro` | Execuções com `integracaoOk = false` (inclui as forçadas por `FAKE_NOTA`) |
| `execucoes.integracaoOkPct` | `(total - comFuro) / total`, uma casa decimal |
| `diagnosticos.resolvidos` | Só conta o que foi fechado via `/diagnostico/entrega` com `diagnosticoId` |
| `serieMaisAfetada` | Série com maior soma de ausentes na janela; `null` se não houve furo |
