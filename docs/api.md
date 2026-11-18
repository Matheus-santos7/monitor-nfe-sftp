# API do monitor (`monitor-sftp`)

Host local: `http://127.0.0.1:8081` (container escuta `0.0.0.0:8080`).  
Rede Docker (n8n): `http://monitor-sftp:8080`.

Autenticação: `MONITOR_HTTP_TOKEN` no `.env` (preferido) ou `http.token` em `config.yml`. Envie `Authorization: Bearer {token}` ou `X-Token`. Evite `?token=` (aparece em logs de proxy). Sem token configurado, os endpoints ficam abertos na rede Docker.

Timeouts no n8n para `/ciclo` (600 s), `/executar` e `/diagnostico` devem ser altos (ZIP do ML + SFTP + SSH). O compose usa 180 s.

## `POST /ciclo` · `POST /ciclo/conferir` (workflow v2)

O ciclo inteiro roda no monitor; o n8n só espera e envia `mensagens[]` (`{assunto, mensagem}`). Ver [ADR-004](decisions/0004-regra-no-monitor-n8n-so-orquestra.md).

`POST /ciclo` · corpo `{ "execucao": "<id da execução n8n>" }`. Checa SFTP + teto ML; para cada NF ausente localiza o `invoice_id`, diagnostica no Nerus e (se o ML não avisou e `CONTINGENCIA` ≠ `off`) renotifica. Resposta:

| Campo | Significado |
|---|---|
| `status` | `ok` · `degradado` (sem furo visível, mas checagem cega — ex.: sem teto ML) · `alerta` (furo ou série sem XML) |
| `lote[]` | Diagnóstico de cada NF ausente. Vazio = nada a conferir |
| `espera` | `10min` (entrega pendente) · `2min` (contingência) · `nenhuma` |
| `notasAusentes[]` · `avisos[]` | Da checagem |
| `mensagens[]` | Para enviar já (resumo ok/degradado ou série sem XML). Vazio quando há `lote` |

Sem retry no n8n: repetir `/ciclo` repete a contingência. Timeout do nó: 600 s.

`POST /ciclo/conferir` · corpo `{ "execucao", "notas": [...notasAusentes], "lote": [...lote] }` (os dois vêm da resposta do `/ciclo`). Rechecha o FTP e devolve `aindaFaltam`, `faltando[]`, `noFtp`, `total` e `mensagens[]` (um relatório por NF + resumo do lote). Só leitura — pode ter retry.

## `GET /health`

```json
{ "ok": true, "ocupado": false }
```

## `GET /painel` · `GET /status`

`/painel?token=...` é a página; ela lê `/status` a cada 1 min. `/status` devolve o estado da última checagem em memória: `status` (`ok` · `alerta` · `erro` · `aguardando`), `checadoEm`, `erro`, `avisos[]`, `resultado` (mesmo formato do `/executar`) e `ausentesDesde` (`"numero/serie"` → ISO da primeira checagem em que o furo apareceu). O estado zera quando o container reinicia.

## `GET /historico?dia=AAAAMMDD`

Histórico de avisos e saúde do dia (padrão: hoje, em America/Sao_Paulo). Gravado a cada checagem em `data/historico/AAAAMMDD.json` (`HISTORICO_DIR`), então sobrevive a restart.

- `eventos[]`: `furo_aberto`, `furo_resolvido` (com `duracaoMin`), `checagem_falhou`, `checagem_voltou`, `aviso`. Cada um só é gravado quando o estado muda.
- `checagens`: `total` / `ok` / `alerta` / `erro`.
- `resumo`: `nivel` (`saudavel` · `atencao` · `critico` = furo aberto há ≥ 60 min), `saudePct`, furos do dia, resolvidos, tempo médio e pior tempo até o XML chegar ao FTP, em aberto, falhas de checagem.
- `dias[]`: dias com histórico gravado.

## `POST /executar` · `GET /executar`

Checagem SFTP + teto ML. `?notify=false` não dispara os webhooks do `config.yml` (o n8n notifica por conta própria).

Se já houver uma checagem em andamento (ex.: a do painel), a chamada espera ela terminar e roda em seguida — não há mais `409`. A resposta traz `avisos[]` (teto ML indisponível, série sem XML).

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

## `POST /diagnostico/entrega` · `GET /diagnostico/entrega`

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
