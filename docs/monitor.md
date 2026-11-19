# Camada de serviço: o backend (`api`)

O monitor é um serviço Node 22 em TypeScript, com `http` nativo e sem framework, em `monitoramento/`. Ele faz toda a regra: checa, diagnostica, decide, monta os textos e serve o painel. O contrato HTTP está em [api.md](api.md). Esta página mostra **onde fica cada coisa** e **como mudar com segurança**.

## Mapa dos módulos (`monitoramento/src/`)

| Módulo | Responsabilidade |
|---|---|
| `index.ts` | Subida: carrega a config, retoma o histórico, sobe o HTTP, inicia a checagem do painel e loga o modo da contingência |
| `config.ts` · `types.ts` | Lê o `config.yml` (`CONFIG_PATH`) e define os tipos compartilhados |
| `http.ts` | Rotas e autenticação em dois níveis (`permissao`: operação/leitura, fecha sem token, só header) |
| `ciclo.ts` | **Orquestra o ciclo:** `rodarCiclo` (status, diagnóstico de cada NF, espera) e `conferirLote` |
| `job.ts` | **A checagem:** SFTP + teto ML + furos. Fila que serializa as checagens, estado do painel, gravação do histórico |
| `gaps.ts` · `chave.ts` | Agrupa os arquivos por série, lê a chave/inutilização do nome do arquivo e calcula os furos. Funções puras |
| `sftp.ts` | Lista os XMLs nos diretórios do SFTP |
| `ml-auth.ts` | OAuth do Mercado Livre: renova e grava o token |
| `ml-invoices.ts` | Baixa o ZIP de NF-e do ML (com cache), calcula o teto por série e localiza a invoice de uma NF |
| `diagnostico.ts` | Consulta o Nerus (`consultarEstadoNerus`), decide a ação (`decidirAcao`), dispara a contingência e monta o texto do diagnóstico (`concluirRelatorio`) |
| `nerus-db.ts` | Túnel SSH até o MySQL do Nerus, com sessão compartilhada por ciclo (`comSessaoNerus`) e timeout por query |
| `nerus-contigencia.ts` | Login na API do Nerus, renotificação e trava de 30 min por invoice |
| `relatorio.ts` | Textos dos avisos: resumo, série sem XML, relatório por NF, resumo do lote. Funções puras |
| `historico.ts` | Arquivo JSON por dia, resumo de saúde (`resumirDia`) |
| `orquestrador.ts` | **Ciclo completo:** ciclo → espera do lote → conferência (→ 2 min → de novo) → avisos; aviso de falha; uma rodada por vez; modo da agenda |
| `avisos.ts` | Envio para Google Chat, WhatsApp (`fetch`) e e-mail (SMTP, `nodemailer`). Cada canal é independente |

O frontend (`painel/index.html`, servido por nginx) fica fora deste serviço; veja [painel.md](painel.md). As integrações (SFTP, ML e Nerus) estão em [integracoes.md](integracoes.md).

## Caminho de um ciclo

A agenda (`index.ts`, `node-cron`) ou o botão "Executar agora" (`POST /ciclo/agora`) chamam `dispararCiclo`:

```
orquestrador.ts  executarCicloCompleto
  1. ciclo.ts rodarCiclo
       checar() ──────────► job.ts executarJob (fila)
                              sftp.listarArquivosFtp
                              ml-invoices.buscarTetosPorSerie
                              gaps.analisarSeries → furos, avisos
                              registrarChecagem → painel + historico
       status ok/degradado → relatorio.mensagemResumo → (vai para o passo 4)
       status alerta:
         validarMl()   (token ML inválido → o ciclo falha → aviso de falha)
         comSessaoNerus(para cada NF):
           localizar (ml-invoices) → diagnosticar (diagnostico.ts)
             consultarEstadoNerus (nerus-db) → decidirAcao
             → reservarContingencia → renotificarInvoice (nerus-contigencia)
         relatorio.decidirEsperaLote → {lote, espera}
  2. espera do lote: 10 min (entrega pendente) ou 2 min (contingência)
  3. ciclo.ts conferirLote → se ainda falta: espera 2 min → conferirLote de novo
  4. avisos.ts enviarAviso para cada mensagem (em sombra: só log)
  qualquer erro → "🚨 O ciclo de monitoramento falhou" (etapa + erro)
```

## Agenda e avisos

| `MODO_AGENDA` | O que acontece |
|---|---|
| `off` | Monitor pausado: nada é agendado e o "Executar agora" fica desligado. O painel continua checando |
| `sombra` (padrão local) | No horário de `AGENDA_CICLO`, roda o ciclo completo **sem contingência** e **sem enviar avisos** (só log e painel) |
| `ativo` (no servidor, via `.env`) | Agenda, espera, confere e avisa de verdade |

- **Agenda:** `node-cron` com `AGENDA_CICLO` (padrão `0 8-18 * * 1-5`, fuso America/Sao_Paulo). Se o horário chega com uma rodada ainda em andamento (por exemplo, na espera de 10 min), a nova é pulada, com log.
- **Avisos:** `avisos.ts`. O Chat recebe `{text}`, o WhatsApp `{number, text}`, e o e-mail vai com assunto e texto puro. Um canal sem variável é pulado. Se nenhum canal entregar um aviso, isso vira um evento no histórico e aparece no painel.
- **Falha no ciclo** (SFTP fora, token do ML, erro na conferência): vira o aviso "🚨 O ciclo de monitoramento falhou", com a etapa e o erro.
- **Restart durante a espera:** o lote em memória se perde. O próximo horário redescobre os furos, e a trava da contingência (em disco) impede que ela saia em dobro.

## Estado e concorrência

- **Fila de checagem** (`job.ts`, `executarJob`): uma checagem por vez. Se o painel e o ciclo pedirem juntos, o segundo espera. Isso evita duas renovações do token do ML ao mesmo tempo.
- **O que fica em memória e some num restart:** o estado do painel (`/status`), a idade dos furos (retomada do histórico do dia na subida), o cache do ZIP e o andamento do ciclo do orquestrador.
- **O que fica em disco**, em `monitoramento/data/`, montado em `/app/data`: o histórico (`historico/AAAAMMDD.json`), os tokens do ML (`ml-tokens.json`) e a trava da contingência (`contingencias.json`, `CONTINGENCIAS_PATH`).
- **O lote só existe durante a rodada**, na memória do orquestrador.

## Tratamento de erro: o que vira o quê

| Falha | Resultado |
|---|---|
| SFTP fora | A checagem falha: aviso de falha nos canais, e o painel mostra "Checagem falhou" |
| ML sem teto (429, credencial) | Aviso → `degradado` / "cobertura parcial" |
| ML falha ao localizar uma NF | Item "Não foi possível consultar o Mercado Livre", e o ciclo segue |
| Nerus fora ou query com erro | Item com o erro, **sem** contingência, e o ciclo segue |
| Token do ML inválido ao diagnosticar | O ciclo falha → aviso de falha |
| Erro inesperado numa rota | 500 "erro interno". O processo **não** cai |
| Histórico corrompido ou sem gravar | O arquivo é movido para `.corrompido-<ms>` / aviso no painel. A checagem segue |

## Testes

```bash
cd monitoramento
npm run check      # tsc --noEmit + testes. É o que o CI roda
npm test           # só os testes (tsx, sem checar tipos)
```

- O framework é o `node:test`. Os arquivos ficam ao lado do código: `avisos.test.ts`, `ciclo.test.ts`, `diagnostico.test.ts`, `gaps.test.ts`, `http.test.ts`, `job.test.ts`, `ml-auth.test.ts`, `ml-invoices.test.ts`, `orquestrador.test.ts`.
- **Nenhum teste acessa a rede.** O ciclo recebe as dependências por `DepsCiclo` (`checar`, `validarMl`, `localizar`, `diagnosticar`), o `diagnosticarNota` recebe `{ consultar, renotificar }` e o orquestrador recebe `DepsOrquestrador` (`ciclo`, `conferir`, `enviar`, `esperar`…). Nos testes, todas são falsas: a espera de 10 min dura zero.
- `job.test.ts` define `HISTORICO_DIR` para uma pasta temporária, para não sujar o `data/` real.
- Mudou uma regra ou um texto? Escreva primeiro o teste que falha, depois mude o código.

## Convenções

- Os nomes, as mensagens e os logs são em português. Os passos do log começam com `▶`.
- Funções que só calculam (`gaps`, `relatorio`, `decidirAcao`) não fazem I/O. É nelas que os testes são baratos.
- Um atalho com limite conhecido leva o comentário `// shortcut: <limite>, <quando melhorar>`.
- Segredos só via `.env` / `config.yml`. Nada de cliente no código nem nos testes.
