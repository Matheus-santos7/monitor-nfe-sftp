# ADR-004: Histórico do monitor no Postgres do n8n, em schema separado

## Status

Accepted

## Date

2026-08-28

## Context

`POST /executar` e `POST /diagnostico` respondiam e esqueciam: nada ficava gravado. Sem histórico não dá para responder "quantas vezes a série 2 furou esta semana?", nem para o resumo por IA planejado adiante — ele precisa de uma fonte agregável, não de logs.

Já existe um Postgres 16 no compose, usado pelo n8n com um usuário não-root e schema `n8n` isolado. O banco fiscal (MySQL do Nerus, via túnel SSH — [ADR-003](0003-diagnostico-via-ssh-mysql.md)) é de terceiro e somente leitura: gravar lá está fora de questão.

## Decision

- Reaproveitar a instância Postgres do n8n com um **schema novo, `monitor`**, e as **mesmas credenciais não-root** que o n8n já usa. Sem usuário novo, sem serviço novo.
- Três tabelas: `execucoes` (uma por `/executar`), `series_resultado` (uma por série da execução) e `diagnosticos` (uma por `/diagnostico`, atualizada pelo `/diagnostico/entrega`). Cada uma guarda também o payload completo em `JSONB`, para não perder informação que ainda não virou coluna.
- Schema aplicado por `src/db-schema.sql` na subida do processo, com `CREATE ... IF NOT EXISTS`. Sem ferramenta de migration nesta fase.
- SQL cru com `pg` (`Pool`), no mesmo estilo do `nerus-db.ts` com `mysql2`. Sem ORM.
- **Modo degradado**: sem `MONITOR_DB_HOST`, o monitor roda exatamente como antes, loga um aviso único na subida e não grava nada. Erro de escrita é logado e engolido — persistência nunca derruba `/executar` nem `/diagnostico`.
- O desfecho gravado em `diagnosticos.resultado_final` vem de `concluirRelatorio`, a mesma função que monta o texto do relatório, para não existirem duas versões da decisão.

## Alternatives considered

### Banco separado (novo serviço no compose)

- Prós: isolamento total; ciclo de vida independente do n8n.
- Contras: mais um container, mais um backup, mais um segredo, para um volume de dados que cabe em megabytes.
- Rejeitado: custo operacional desproporcional nesta fase.

### Schema `public` do mesmo banco

- Prós: um passo a menos no `init-data.sh`.
- Contras: mistura com o que o n8n eventualmente crie ali; `DROP SCHEMA monitor CASCADE` deixa de ser um rollback limpo.
- Rejeitado.

### Arquivos JSON/SQLite em disco

- Prós: zero dependência nova.
- Contras: o container do monitor não tem volume de dados versionado além de `data/` (tokens ML); agregação por período em JSON é código que não queremos escrever.
- Rejeitado.

### Ferramenta de migration (node-pg-migrate, drizzle-kit)

- Prós: histórico versionado do schema.
- Contras: peso e cerimônia para três tabelas que ainda vão mudar de forma.
- Adiado, não rejeitado: quando a primeira alteração destrutiva aparecer, vale reabrir.

## Consequences

- O monitor passa a depender do Postgres estar de pé para gravar — mas **não** para funcionar. `depends_on: service_healthy` só ordena a subida.
- `init-data.sh` só roda em volume novo; por isso o `db-schema.sql` também faz `CREATE SCHEMA IF NOT EXISTS monitor` (o usuário não-root tem `CREATE` no banco).
- `tsc` não copia `.sql`: o `Dockerfile` copia `src/db-schema.sql` para `dist/` à mão. Se o arquivo sumir do build, o histórico cai em modo degradado com erro no log, não em crash.
- Sem `diagnosticoId` no `/diagnostico/entrega`, o diagnóstico fica gravado com `resultado_final = NULL` (aberto). O `GET /historico` conta esses casos no `total`, mas não em `resolvidos`.
- Retenção: nada apaga linha nenhuma ainda. Com o volume atual (uma execução por ciclo de cron) isso leva anos para incomodar, mas é dívida conhecida.
