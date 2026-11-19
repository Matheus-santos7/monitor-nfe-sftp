# Documentação

Comece pelo [README da raiz](../README.md): visão geral, glossário, como rodar local e mudanças comuns. Cada documento abaixo cobre **uma camada**. Os outros só apontam para ele, sem repetir.

## Por onde começar

| Quero… | Leia |
|---|---|
| Entender o que é furo, teto, contingência e o que o monitor decide | [regra-de-negocio.md](regra-de-negocio.md) |
| Achar onde mudar algo no código | [monitor.md](monitor.md) |
| Mudar horário, modo da agenda ou canais de aviso | [monitor.md](monitor.md#agenda-e-avisos) |
| Entender um erro de SFTP, Mercado Livre ou Nerus | [integracoes.md](integracoes.md) |
| Ler o painel ou o histórico do dia | [painel.md](painel.md) |
| Chamar o monitor pela HTTP | [api.md](api.md) |
| Subir no servidor AWS, ver logs, migrar, voltar uma versão ou recuperar o token do ML | [deploy.md](deploy.md) |
| Mudar o código e abrir um PR | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Ver todas as variáveis do `.env` | [deploy.md](deploy.md#referência-das-variáveis-do-env) |
| Saber por que algo foi feito assim | [decisions/](decisions/) |

## Camadas

| Camada | Documento | Código |
|---|---|---|
| Regra de negócio | [regra-de-negocio.md](regra-de-negocio.md) | `gaps.ts`, `diagnostico.ts` (`decidirAcao`), `ciclo.ts`, `relatorio.ts` |
| Serviço monitor (ciclo, agenda, avisos) | [monitor.md](monitor.md) | `monitoramento/src/` (`orquestrador.ts`, `avisos.ts`, `index.ts`) |
| Integrações | [integracoes.md](integracoes.md) | `sftp.ts`, `ml-auth.ts`, `ml-invoices.ts`, `nerus-db.ts`, `nerus-contigencia.ts` |
| Visualização (frontend) | [painel.md](painel.md) | `painel/index.html`, `painel/nginx.conf`, `historico.ts`, `job.ts` |
| Contrato HTTP | [api.md](api.md) | `http.ts` |
| Infra e operação (AWS) | [deploy.md](deploy.md) | `docker-compose.yml`, `Caddyfile`, `.env.example`, `.github/workflows/ci.yml` |

## Decisões (ADRs)

| ADR | Decisão |
|---|---|
| [0001](decisions/0001-relatorio-zip-em-vez-de-search.md) | O `invoice_id` sai do ZIP do ML, não do `/invoices/search` (403) |
| [0002](decisions/0002-teto-da-sequencia-pelo-ml.md) | O teto da sequência é a última NF do ML, não a última do FTP |
| [0003](decisions/0003-diagnostico-via-ssh-mysql.md) | Diagnóstico no MySQL do Nerus via bastion SSH. A parte de orquestração foi substituída pelo ADR-004 |
| [0004](decisions/0004-regra-no-monitor-n8n-so-orquestra.md) | A regra fica no monitor (`/ciclo`); o n8n só agenda, espera e avisa |
| [0005](decisions/0005-agenda-e-avisos-no-monitor.md) | O monitor agenda, espera e avisa; o n8n saiu do projeto |
| [0006](decisions/0006-um-compose-painel-separado-e-https.md) | Um compose (api, painel, proxy Caddy), um DNS por serviço com HTTPS |
| [0007](decisions/0007-login-do-painel-sem-token-na-url.md) | Login por conta (cookie de sessão, CSRF, limite de tentativas); nada de token na URL |

ADRs são registro histórico: não se reescrevem, só se substituem por um novo.

## Outros

- [../PROJECT-CONTEXT.md](../PROJECT-CONTEXT.md): contexto resumido para sessões de análise.
- [team-sessions/](team-sessions/): registros das sessões Dev Team.
