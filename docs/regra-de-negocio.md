# Regra de negócio

Esta página explica o que o monitor considera um problema e o que ele faz em cada caso. As séries, o seller e o tenant vêm do `.env` e do `config.yml`. O código citado fica em `monitoramento/src/`.

## Termos

| Termo | Significado |
|---|---|
| **Série** | Numeração fiscal da NF-e (ex.: série 2). Cada série tem a sua sequência. Ficam em `series[]` no `config.yml`. |
| **`nota_inicial`** | Primeiro número da série que precisa estar no FTP. Os anteriores são ignorados. |
| **Teto** | Maior número autorizado no relatório do Mercado Livre no dia. É até onde a sequência precisa estar completa. |
| **Furo** | Número entre `nota_inicial` e o teto que não está no FTP. |
| **Lote** | Os furos de um ciclo, diagnosticados juntos e conferidos juntos. |
| **Contingência** | Reenviar ao gateway Nerus o aviso que o ML deveria ter mandado. É uma ação real em produção. |
| **Cobertura degradada** | A checagem rodou, mas está cega numa parte (ex.: sem teto do ML). Nunca é mostrada como "ok". |

## 1. Checagem

A agenda do monitor roda o ciclo seg–sex, de hora em hora, das 8h às 18h (`AGENDA_CICLO`). O painel também roda a mesma checagem a cada 5 min, mas sem diagnóstico e sem aviso.

1. **Lista os XMLs** nos diretórios do SFTP (`sftp.ts`). Um diretório que falha é pulado, com aviso no log.
2. **Conta os números por série** a partir do nome do arquivo (`gaps.ts`, `chave.ts`):
   - `…NFe<chave 44>.xml` ou um nome que começa com a chave: a série e o número saem da chave. Só entra o modelo 55 (NF-e).
   - `…Inut-ID<dígitos>.xml`: uma inutilização conta **todos** os números da faixa como presentes.
3. **Busca o teto no ML** (`ml-invoices.ts`). É o maior número por série no ZIP de NF-e autorizadas do dia (`ML_TETO_DIAS=1`). O ZIP fica em cache por `ML_TETO_CACHE_MIN` (padrão 5 min).
4. **Calcula os furos:** todo número de `nota_inicial` até o teto que não está no FTP. Isso inclui o próprio teto, ou seja, a última nota emitida.
   - Sem teto (credencial ausente, 429, nenhuma emissão no dia), o limite vira o maior número no FTP. Furos no fim da sequência ficam invisíveis, e isso entra em `avisos[]`.
   - Série configurada sem nenhum XML no FTP também vira aviso ("Série X: nenhum XML no FTP") e conta como problema.

## 2. Resultado do ciclo

| `status` | Quando | O que é enviado |
|---|---|---|
| `ok` | Sem furo, com todas as séries com XML e sem avisos | Resumo "100% OK" |
| `degradado` | Sem furo visível, mas com algum aviso (ex.: sem teto do ML) | "Monitoramento com cobertura parcial" e o motivo |
| `em_transito` | Só há notas ausentes há menos que a tolerância | Nada ainda (seção 2b) |
| `alerta` | Há furo (ausente há ≥ tolerância) ou série sem XML | Diagnóstico de cada NF (seção 3) |

No painel, o `degradado` aparece como `erro`, com o texto "Checagem incompleta — veja os avisos". O nome muda, mas a regra é a mesma: nunca verde.

## 2a. O que vai para o Google Chat

O canal só recebe o que pede atenção:

| Situação | Vai para o Chat? |
|---|---|
| Furo (nota ausente há ≥ tolerância), série sem XML, falha do ciclo | **Sempre** |
| Cobertura parcial (`degradado`) | Só quando o estado **muda** (não repete a cada hora) |
| Voltou ao normal (estava em furo, falha ou parcial e agora está ok) | Sim, um aviso de volta ao normal |
| Tudo ok e continua ok, ou notas em trânsito | Não |
| **Resumo do período**, às **10h** (desde as 18h do dia útil anterior, incluindo a madrugada) e às **18h** (desde as 10h) | Sim (`RESUMO_CRON`) |

As mensagens no Chat são curtas: o título em negrito, o que aconteceu, o que o monitor fez, o que fazer e o link do painel. O **rastro técnico** (tabelas, ids) fica só no painel e no log.

## 2b. Tolerância: nota em trânsito

Uma nota que acabou de ser autorizada pode levar alguns minutos para chegar ao FTP (atraso normal de integração). Para não gerar alarme falso, **uma nota ausente há menos de `TOLERANCIA_MIN` (padrão 20 min) fica "em trânsito"**:

- não é diagnosticada, não dispara contingência e não gera aviso no Chat;
- aparece como aviso no painel ("N nota(s) em trânsito há até X min") e o ciclo fica com o status `em_transito`, que **nunca** é verde;
- passou da tolerância e continua faltando: vira **furo** e segue a seção 3.

Detalhes:

- **Relógio:** a idade é contada a partir da primeira checagem que viu a nota faltar. A checagem do painel roda a cada 5 min, 24 h, e esse "desde" fica gravado no histórico e sobrevive a um restart. Uma nota nunca vista antes conta a partir de agora: a tolerância pode atrasar o primeiro alerta em até 20 min, mas nunca esconde o furo.
- **Último ciclo do dia (18h):** ignora a tolerância. Uma nota ausente há 5 min às 18h já é tratada como furo, para nenhum furo esperar até o dia seguinte.
- **Por que 20 min:** no histórico medido, todos os atrasos normais de integração chegaram ao FTP em até 20 min, e 92% em até 10 min. Ajuste com `TOLERANCIA_MIN` se o padrão mudar.
- O painel usa o mesmo valor: a linha da nota ausente fica vermelha quando passa da tolerância.

## 3. Diagnóstico de cada NF ausente

Para **cada** furo do ciclo, uma NF por vez (`ciclo.ts`):

1. **Acha o `invoice_id` e a chave** no ZIP do ML. Tenta o dia, depois os últimos 7 dias, depois o mês.
   - Não achou: "a nota não foi encontrada no relatório do Mercado Livre". Pede o time técnico.
   - A API do ML falhou: "Não foi possível consultar o Mercado Livre: <motivo>". Também pede o time técnico. Não é a mesma coisa que "não achou".
2. **Consulta o Nerus** pelo MySQL, via SSH (`diagnostico.ts`, `consultarEstadoNerus`). Todas as NFs do ciclo usam **um único** túnel. As tabelas estão em [integracoes.md](integracoes.md#nerus).
3. **Decide a ação** (`decidirAcao`):

| Situação no Nerus | Ação | Admin? |
|---|---|---|
| O ML não avisou (sem linha em `notification_control`) | **Contingência** e espera de 2 min | sim |
| Avisou, mas a nota não está em `invoice` | nenhuma | sim |
| Nota integrada, entrega `SENT` | rechecar o FTP | não |
| Nota integrada, entrega `PENDING` / `PROCESSING` / `RETRY_SCHEDULED` ou status desconhecido | esperar 10 min | sim |
| Nota integrada, entrega `FAILED` / `SKIPPED` / `CANCELED` | nenhuma | sim |
| Nota integrada, sem linha de entrega | nenhuma | sim |
| Alguma consulta ao Nerus deu erro | nenhuma: **não** dispara contingência "no escuro" | sim |

Uma falha numa NF não derruba o ciclo. A NF segue no lote com o erro, e o relatório pede o time técnico.

## 4. Contingência

Só acontece quando o ML **não** avisou o gateway **e** `CONTINGENCIA=on`, que só o `.env` do servidor define (`nerus-contigencia.ts`):

1. Faz login na API do Nerus (`NERUS_AUTH_URL`).
2. Envia `POST {NERUS_NOTIFICATION_URL}?clientId={tenant}` com o aviso no formato do feed `invoices` (`topic`, `resource=/users/<seller>/invoices/<invoiceId>`, um `_id` novo).

**Trava:** a mesma invoice não é renotificada duas vezes em 30 min. Isso protege contra um "Executar agora" logo depois de um timeout, ou contra dois agendadores ativos ao mesmo tempo. A trava fica gravada em `data/contingencias.json` e sobrevive a um restart. Se a renotificação falhar, a trava é liberada e o próximo ciclo tenta de novo.

Com `CONTINGENCIA` diferente de `on`, o diagnóstico roda inteiro, mas o relatório diz "não disparada neste ciclo".

## 5. Espera e conferência do lote

1. **Uma espera para o lote inteiro:** 10 min se alguma NF aguarda envio, senão 2 min se houve contingência. A de 10 min vence.
2. O monitor reconfere o FTP de **todas** as NFs do lote (`conferirLote`).
3. Se ainda faltar alguma, espera mais 2 min e confere de novo.
4. Na última conferência sai **um relatório por NF** e **um resumo do lote** ("3/5 no FTP").

O lote só existe durante a rodada. Se o monitor reiniciar na espera, o próximo horário redescobre os furos ([ADR-005](decisions/0005-agenda-e-avisos-no-monitor.md)).

## 6. Formato do relatório de uma NF

A ordem é sempre esta (`relatorio.ts`, `relatorioNota`):

1. **Resultado:** ✅ resolvido, ⚠️ ainda ausente ou ⚠️ precisa de atenção.
2. **O que fazer:** nada, aguardar ou acionar o time técnico.
3. **O que aconteceu:** a causa, em linguagem comum, sem nome de tabela.
4. **O que o monitor fez:** contingência, aviso já reenviado (trava), espera ou reconsulta.
5. **Onde a integração parou:** só se não resolveu, e só até o primeiro erro.
6. **Rastro técnico:** cada consulta com tabela, filtro, linhas, ids e status, mais o identificador da execução (`agenda-…` ou `manual-…`).

## 7. `FAKE_NOTA`

`FAKE_NOTA=99999/2` no `.env` injeta essa NF como ausente depois da análise real, para exercitar o fluxo sem um furo de verdade. Use um número que não existe: ele cai em "não encontrada no relatório do ML" e não dispara contingência. Para desligar, deixe vazio (ou `0`, `off`, `false`) e recrie o container.
