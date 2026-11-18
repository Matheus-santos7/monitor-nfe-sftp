# ADR-004: Regra de negócio no monitor; n8n só agenda, espera e avisa

## Status

Accepted. Atualiza a parte de orquestração do ADR-003. A parte de SSH e MySQL do ADR-003 continua valendo.

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
- O workflow v2 (`workflows/monitor-sftp-v2.json`) não tem nenhum nó Code. São só gatilho, `/ciclo`, Wait, `/ciclo/conferir`, Split Out e os envios.
- O nó `/ciclo` **não** tem nova tentativa automática: repetir o pedido repetiria a contingência.
- `CONTINGENCIA=off` diagnostica sem renotificar. Use para homologação e para comparar v1 com v2.
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

- O `ciclo-paridade.test.ts` roda o JS original do v1 e garante o mesmo texto. Ele deve ser apagado junto com o `workflows/monitor-sftp.json`.
- Texto novo, que não existia no v1: "Monitoramento com cobertura parcial", enviado quando há avisos e nenhum furo visível.
- Nunca ativar o v1 e o v2 ao mesmo tempo, porque a contingência rodaria em dobro.
- Trava no monitor: a mesma invoice não é renotificada duas vezes em 30 min, mesmo com v1+v2 ativos ou com um "Executar agora" logo depois de um timeout do n8n (o `/ciclo` continua rodando no servidor quando o n8n desiste). A trava fica em memória, então um restart do monitor a zera.
- Um `/ciclo` abre **um** túnel SSH + MySQL para todas as NFs (`comSessaoNerus`), em vez de um por query. Se a abertura falhar, todas as NFs do ciclo registram o erro na hora, sem esperar 20 s cada. O timeout de 600 s do nó `/ciclo` ainda precisa ser medido com um lote real.
