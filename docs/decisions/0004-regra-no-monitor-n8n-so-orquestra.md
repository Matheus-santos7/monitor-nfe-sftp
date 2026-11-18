# ADR-004: Regra de negócio no monitor; n8n só agenda, espera e avisa

## Status

Accepted. A parte de orquestração (n8n agenda, espera e avisa) está sendo substituída pelo [ADR-005](0005-agenda-e-avisos-no-monitor.md). Atualiza a parte de orquestração do ADR-003. A parte de SSH e MySQL do ADR-003 continua valendo.

## Date

2026-11-18

## Context

No workflow v1, cerca de 670 linhas de JS em nós Code decidiam o lote, a espera, a conferência e o texto dos avisos, e não havia nenhum teste para elas. As mudanças eram aplicadas por scripts avulsos (`tmp-patch-*`). Isso causava três problemas:

- **Falso verde:** o nó "Montar resumo" recalculava `integracaoOk` e ignorava `avisos`. Sem teto do ML, o chat recebia "100% OK".
- **Estado compartilhado:** o lote ficava em `$getWorkflowStaticData('run')`, que é compartilhado entre execuções. Uma execução manual e outra agendada podiam sobrescrever o lote uma da outra.
- **Regra em dois lugares:** o `FAKE_NOTA` e o `integracaoOk` existiam no n8n e no monitor. Três nós sem entrada (`Próxima ação`, `Rechecar entrega no Nerus`, `Ainda faltam no FTP?`) davam a impressão de um fluxo que já não rodava.

A sessão Dev Team de 2026-11-18 (`docs/team-sessions/`) classificou isso como bloqueante.

## Decision

- O monitor expõe o ciclo inteiro:
  - `POST /ciclo`: checar, diagnosticar cada NF (com contingência) e decidir a espera.
  - `POST /ciclo/conferir`: rechecar o FTP e devolver os relatórios.
- Os textos ficam em `relatorio.ts`, com funções puras, e a orquestração em `ciclo.ts`, com dependências injetáveis.
- O lote volta do n8n no corpo do `/ciclo/conferir`. O monitor não guarda estado do lote.
- `status` = `ok` · `degradado` (sem furo visível, mas com a checagem cega) · `alerta`.
- O workflow (`workflows/monitor-sftp.json`) não tem nenhum nó Code. São só gatilho, `/ciclo`, Wait, `/ciclo/conferir`, Split Out e os envios.
- O nó `/ciclo` **não** tem nova tentativa automática: repetir o pedido repetiria a contingência.
- A contingência só liga com `CONTINGENCIA=on` explícito, e só o `docker-compose.prod.yml` define esse valor. Vazio ou ausente = desligada, para que rodar local com credenciais reais não aja em produção.
- Falha no diagnóstico de uma NF não derruba mais o ciclo inteiro. A NF entra no lote com o erro.

## Alternatives considered

### Manter a regra no n8n e testar os nós Code

- Prós: menos mudança agora.
- Contras: exige um mock do runtime do n8n em cada teste, e a regra continua duplicada.
- Rejeitado.

### Monitor espera os 2/10 min sozinho (sem Wait do n8n)

- Prós: um único request.
- Contras: request preso por 10 min ou mais, e um restart no meio perde o lote. É o mesmo motivo do ADR-003.
- Rejeitado.

## Consequences

- Durante a migração, um teste de paridade rodou o JS original do v1 e confirmou o mesmo texto. Em 2026-11-18 o v1 saiu do repositório junto com esse teste, as rotas que só ele usava (`/executar`, `/ml/me`, `/ml/invoice`, `/diagnostico`, `/diagnostico/entrega`) e o envio direto de webhook pelo monitor. Rollback: o histórico do Git (commit `b8fe41c` e anteriores).
- Texto novo, que não existia no v1: "Monitoramento com cobertura parcial", enviado quando há avisos e nenhum furo visível.
- Um único workflow de monitoramento ativo por cliente; dois ativos rodariam a contingência em dobro.
- Trava no monitor: a mesma invoice não é renotificada duas vezes em 30 min, mesmo com dois workflows ativos ou com um "Executar agora" logo depois de um timeout do n8n (o `/ciclo` continua rodando no servidor quando o n8n desiste). A trava fica em memória, então um restart do monitor a zera.
- Um `/ciclo` abre **um** túnel SSH + MySQL para todas as NFs (`comSessaoNerus`), em vez de um por query. Se a abertura falhar, todas as NFs do ciclo registram o erro na hora, sem esperar 20 s cada. O timeout de 600 s do nó `/ciclo` ainda precisa ser medido com um lote real.
