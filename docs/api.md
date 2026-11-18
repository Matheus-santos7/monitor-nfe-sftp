# API do monitor (`monitor-sftp`)

Contrato HTTP do monitor. O código fica em `monitoramento/src/http.ts`; os módulos por trás de cada rota estão em [monitor.md](monitor.md).

Host local: `http://127.0.0.1:8081` (o container escuta `0.0.0.0:8080`).  
Rede Docker (n8n): `http://monitor-sftp:8080`.

| Rota | Token | Quem chama | Efeito |
|---|---|---|---|
| `GET /health` | não | Docker / você | Vivo? Não toca em nada externo |
| `GET /painel` | sim (`?token=` aceito) | navegador | A página do painel |
| `GET /status` | sim | painel | Última checagem, em memória |
| `GET /historico?dia=` | sim | painel | Histórico e saúde do dia |
| `POST /ciclo` | sim | n8n | **Pode disparar contingência real** |
| `POST /ciclo/conferir` | sim | n8n | Só leitura (SFTP + ML) |
| `GET /ml/teto` | sim | você (depuração) | Só leitura (ZIP do ML) |

Toda resposta JSON tem `ok: true|false`. Em erro, ela traz `erro: "<mensagem>"`. Uma rota inexistente responde 404, com a lista de rotas.

Autenticação: `MONITOR_HTTP_TOKEN` no `.env` (preferido) ou `http.token` em `config.yml`. Envie `Authorization: Bearer {token}` ou `X-Token`. `?token=` só é aceito em `/painel` (para abrir no navegador; a página responde com `Referrer-Policy: no-referrer` e chama `/status` e `/historico` com o header). **Sem token configurado, todas as rotas exceto `/health` respondem 401** — o `POST /ciclo` dispara contingência real.

Erros de entrada: JSON inválido ou corpo que não é objeto → 400; corpo acima de 1 MB → 413. `notas[]` precisa de 1–500 itens com `numero` e `serie` inteiros positivos; itens de `lote[]` sem `numero`/`serie` válidos → 400.

Timeouts no n8n para `/ciclo` (600 s) e `/ciclo/conferir` devem ser altos (ZIP do ML + SFTP + SSH).

## `POST /ciclo` · `POST /ciclo/conferir`

O ciclo inteiro roda no monitor; o n8n só espera e envia `mensagens[]` (`{assunto, mensagem}`). Ver [ADR-004](decisions/0004-regra-no-monitor-n8n-so-orquestra.md).

`POST /ciclo` · corpo `{ "execucao": "<id da execução n8n>" }`. Checa SFTP + teto ML; para cada NF ausente localiza o `invoice_id`, diagnostica no Nerus e renotifica se o ML não avisou e `CONTINGENCIA=on` (só o `docker-compose.prod.yml` liga). Resposta:

| Campo | Significado |
|---|---|
| `status` | `ok` · `degradado` (sem furo visível, mas checagem cega — ex.: sem teto ML) · `alerta` (furo ou série sem XML) |
| `lote[]` | Diagnóstico de cada NF ausente. Vazio = nada a conferir |
| `espera` | `10min` (entrega pendente) · `2min` (contingência) · `nenhuma` |
| `notasAusentes[]` · `avisos[]` | Da checagem |
| `mensagens[]` | Para enviar já (resumo ok/degradado ou série sem XML). Vazio quando há `lote` |

Sem retry no n8n: repetir `/ciclo` repetiria a contingência. O monitor segura a mesma invoice por 30 min (trava em memória), mas não conte com isso para retry. Um único túnel SSH + MySQL atende todas as NFs do ciclo. Timeout do nó: 600 s.

`POST /ciclo/conferir` · corpo `{ "execucao", "notas": [...notasAusentes], "lote": [...lote] }` (os dois vêm da resposta do `/ciclo`). Rechecha o FTP e devolve `aindaFaltam`, `faltando[]`, `noFtp`, `total` e `mensagens[]` (um relatório por NF + resumo do lote). Só leitura — pode ter retry.

## `GET /health`

```json
{ "ok": true, "ocupado": false }
```

## `GET /painel` · `GET /status`

`/painel?token=...` é a página; ela lê `/status` a cada 1 min. `/status` devolve o estado da última checagem em memória: `ocupado`, `intervaloMin`, `cliente`, `status` (`ok` · `alerta` · `erro` · `aguardando`), `checadoEm`, `erro`, `avisos[]`, `resultado` (tabela abaixo) e `ausentesDesde` (`"numero/serie"` → ISO da primeira checagem em que o furo apareceu). O estado zera quando o container reinicia. Se já houver uma checagem em andamento, a próxima espera ela terminar.

Campos de `resultado`:

| Campo | Significado |
|---|---|
| `series[].max` | Último número **no FTP** |
| `series[].tetoMl` | Último número **autorizado no ML** na janela |
| `series[].ultimaMlNoFtp` | `true` se o teto está no FTP; `false` se falta; `null` se o teto não foi consultado |
| `series[].pulos` | Furos de `nota_inicial` até o teto |
| `notasAusentes` | Lista completa dos números ausentes no FTP |
| `integracaoOk` | Sem furos (e sem `FAKE_NOTA`) |
| `tetoPeriodo` | `{ start, end }` `AAAAMMDD` |

## `GET /historico?dia=AAAAMMDD`

Histórico de avisos e saúde do dia (padrão: hoje, em America/Sao_Paulo; `dia` fora do formato → 400). Um arquivo ilegível é movido para `AAAAMMDD.json.corrompido-<ms>` e o dia recomeça, sem parar a checagem; falha ao gravar aparece em `avisos[]` do painel. Gravado a cada checagem em `data/historico/AAAAMMDD.json` (`HISTORICO_DIR`), então sobrevive a restart.

- `eventos[]`: `furo_aberto`, `furo_resolvido` (com `duracaoMin`), `checagem_falhou`, `checagem_voltou`, `aviso`. Cada um só é gravado quando o estado muda.
- `checagens`: `total` / `ok` / `alerta` / `erro`.
- `resumo`: `nivel` (`saudavel` · `atencao` · `critico` = furo aberto há ≥ 60 min), `saudePct`, furos do dia, resolvidos, tempo médio e pior tempo até o XML chegar ao FTP, em aberto, falhas de checagem.
- `dias[]`: dias com histórico gravado.

## `GET /ml/teto`

Últimas NFs autorizadas por série no ZIP.

Query: `start`, `end` (`AAAAMMDD`), `series=2,8`.

Sem `start`/`end`, usa `ML_TETO_DIAS` (padrão **1** = só hoje).

```bash
curl -H "Authorization: Bearer $MONITOR_HTTP_TOKEN" "http://127.0.0.1:8081/ml/teto?series=2"
```

Chamadas a esta rota contam no limite de taxa do ML. O cache (`ML_TETO_CACHE_MIN`) é compartilhado com a checagem.

Não existe `GET /invoices/search` utilizável nesta app (403 PolicyAgent). Ver [ADR-001](decisions/0001-relatorio-zip-em-vez-de-search.md).
