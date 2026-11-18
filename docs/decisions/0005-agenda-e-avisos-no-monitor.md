# ADR-005: O monitor agenda, espera e avisa (sair do n8n)

## Status

Accepted. Substitui a parte de orquestração do ADR-004. A regra de negócio continua no monitor, como o ADR-004 definiu.

A transição está em andamento:

- **Já no código:** agenda, espera do lote, avisos, aviso de falha, trava da contingência em disco e o botão "Executar agora".
- **Ainda não feito:** desligar o n8n em produção e tirar o n8n, o Postgres e o Traefik do compose.

## Date

2026-11-18

## Context

Depois do ADR-004, o workflow do n8n já não decidia nada. Ele só agendava, esperava 2 ou 10 minutos, chamava `/ciclo/conferir` e repassava `mensagens[]` para três canais. Mesmo assim, foi a origem da maior parte dos riscos levantados nas revisões:

- dois workflows ativos rodavam a contingência em dobro;
- a ordem de deploy entre o workflow e o monitor era obrigatória;
- o JSON do repositório podia divergir do que estava no editor;
- nós com `continueRegularOutput` engoliam erros;
- o workflow não tinha nenhum teste.

Além disso, o n8n trazia duas peças só para ele, o Postgres e o Traefik, para um único cliente.

## Decision

- **`orquestrador.ts`:** executa o mesmo grafo do workflow, ou seja, ciclo, espera do lote, conferência, mais 2 min, nova conferência e avisos.
  - Roda uma rodada por vez.
  - Qualquer falha vira o aviso "🚨 O ciclo de monitoramento falhou", que é o antigo Error Handler.
- **`avisos.ts`:** envia para Google Chat e WhatsApp por `fetch` e para e-mail por SMTP (`nodemailer`).
  - Cada canal é independente.
  - Se nenhum canal entregar um aviso, isso vira um evento no histórico. O n8n terminava verde nesse caso.
- **`MODO_AGENDA`:** define quem agenda.
  - `off` (padrão): o n8n continua agendando.
  - `sombra`: o monitor roda o ciclo sem contingência e sem enviar avisos, para comparar com o n8n.
  - `ativo`: o monitor substitui o n8n.
- **Trava da contingência em `data/contingencias.json`:** um restart durante a espera perde o lote em memória. O próximo horário redescobre os furos, e a trava impede a contingência em dobro. Isso responde à objeção do ADR-003 ("um restart no meio perde o lote").
- **Botão "Executar agora" no painel (`POST /ciclo/agora`):** só funciona fora do modo `off`, para não somar uma rodada às do n8n.

## Alternatives considered

### Manter o n8n como está

- **Prós:**
  - não exige mudança;
  - mantém o histórico visual de execuções;
  - mantém a edição de avisos sem código.
- **Contras:**
  - mantém os riscos listados no Context;
  - mantém o Postgres e o Traefik a mais;
  - mantém o fluxo sem testes.
- Rejeitado.

### Espera dentro do `/ciclo` (um request que dura 12 min)

- **Prós:** continua sem agendador no monitor.
- **Contras:** um request preso por mais de 10 min, com o timeout do chamador. Ainda dependeria do n8n para agendar e avisar.
- Rejeitado.

## Consequences

- O fluxo inteiro passa a ser testável: `orquestrador.test.ts` e `avisos.test.ts`, com espera e canais falsos.
- O histórico de execuções do n8n deixa de existir depois da troca. O painel, com "Ciclo de monitoramento", o histórico do dia e o log substituem esse histórico.
- Trocar um canal de aviso passa a exigir uma variável no `.env` e a recriação do container, não uma edição no editor.
- A credencial SMTP sai do n8n e vai para o `.env` (`SMTP_*`).
- A transição segue `docs/deploy.md` (seção 3b). A remoção do n8n do compose fica para quando o modo `ativo` estiver estável.
