# API do monitor (serviço `api`)

Contrato HTTP do monitor. O código fica em `monitoramento/src/http.ts`; os módulos por trás de cada rota estão em [monitor.md](monitor.md).

No servidor: `https://API_HOST` (via proxy HTTPS). No próprio servidor ou local: `http://127.0.0.1:8081` (`API_PORTA`). O painel (`https://PAINEL_HOST`) repassa só `/status`, `/historico`, `/ciclo/agora` e `/health`.

| Rota | Token | Quem chama | Efeito |
|---|---|---|---|
| `GET /health` | não | Docker / você | Vivo? Não toca em nada externo |
| `GET /status` | leitura | painel | Última checagem, em memória, com `permissao` e `usuario` |
| `POST /login` · `POST /logout` · `GET /sessao` | — | painel | Login (só pelo `PAINEL_HOST`; no `API_HOST` respondem 404) |
| `GET /historico?dia=` | leitura | painel | Histórico e saúde do dia |
| `POST /ciclo/agora` | **operação** | botão do painel | Ciclo completo em segundo plano. **Em `ativo`, pode disparar contingência real** |
| `GET /ml/teto` | **operação** | você (depuração) | Só leitura (ZIP do ML) |

Toda resposta JSON tem `ok: true|false`. Em erro, ela traz `erro: "<mensagem>"`. Uma rota inexistente responde 404, com a lista de rotas.

Autenticação, **nunca pela URL**:

| Como | Para quem | Nível |
|---|---|---|
| Cookie de sessão (login no painel, `POST /login`) | Pessoas (contas em `PAINEL_USUARIOS`) | O papel da conta: `leitura` ou `operacao` |
| `Authorization: Bearer <MONITOR_HTTP_TOKEN>` (ou `X-Token`) | Scripts e integrações | `operacao` |

- Com `leitura`, as rotas de operação respondem **403**. Sem acesso válido, **401**.
- Com cookie, toda rota que muda algo (`POST`) exige o header `X-Painel: 1` e `Origin` igual a `https://PAINEL_HOST`, senão **403** (proteção contra CSRF). O Bearer não precisa disso.
- `POST /login` (`{"usuario", "senha"}`, corpo de até 4 KB): `200` devolve o cookie; `401` para usuário ou senha errados (a mensagem não diz qual); `429` depois de 5 erros do mesmo usuário e IP (ou 20 do mesmo IP) em 15 min; `503` sem `SESSAO_SEGREDO`.
- O `API_HOST` repassa só o Bearer: o proxy remove o `Cookie`, e `/login`, `/logout` e `/sessao` respondem 404 ali.

## `POST /ciclo/agora`

Roda o ciclo completo, igual ao agendado: checagem, diagnóstico de cada furo (com contingência em `ativo`), espera do lote, conferência e envio dos avisos. É o que o botão "Executar agora" do painel chama. O ciclo está descrito em [regra-de-negocio.md](regra-de-negocio.md). Responde na hora, sem esperar o fim:

| Código | Quando |
|---|---|
| `202` | Iniciou. O andamento aparece em `GET /status` → `ciclo` |
| `409` | `MODO_AGENDA=off` (monitor pausado) ou já há um ciclo em andamento |

Com `MODO_AGENDA=sombra`, roda sem contingência e não envia avisos.

## `GET /health`

```json
{ "ok": true, "ocupado": false }
```

## `GET /status`

O painel lê `/status` a cada 1 min. `/status` devolve `permissao` (`leitura` ou `operacao`), o estado da última checagem em memória: `ocupado`, `intervaloMin`, `cliente`, `ciclo` (modo da agenda, próximo horário, etapa em andamento, resultado do último ciclo), `status` (`ok` · `alerta` · `erro` · `aguardando`), `checadoEm`, `erro`, `avisos[]`, `resultado` (tabela abaixo) e `ausentesDesde` (`"numero/serie"` → ISO da primeira checagem em que o furo apareceu). O estado zera quando o container reinicia. Se já houver uma checagem em andamento, a próxima espera ela terminar.

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
