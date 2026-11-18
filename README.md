# Monitor NF-e Mercado Livre × SFTP

Detecta NF-e autorizada no Mercado Livre que **ainda não chegou ao SFTP do cliente**. Aponta em que etapa da integração fiscal a nota parou (aviso do ML → gateway Nerus → envio ao FTP) e, quando o ML não avisou o gateway, **dispara a contingência** (reenvia o aviso). O objetivo é agir antes de o cliente perceber.

> ⚠️ **Roda contra sistemas reais de produção. Não existe staging.** A contingência renotifica o gateway fiscal de verdade, e o token do Mercado Livre é de uso único. Leia [Antes do primeiro `up`](#rodar-localmente) antes de subir qualquer coisa.

## Como funciona

```
n8n  (agenda seg–sex 8h–18h, espera, envia Chat / e-mail / WhatsApp)
  │  POST /ciclo, POST /ciclo/conferir
  ▼
monitor-sftp  (toda a regra + painel)
  ├─ SFTP do cliente ........ quais XMLs chegaram
  ├─ Mercado Livre .......... última NF autorizada (teto) e invoice_id
  └─ Nerus (MySQL via SSH) .. onde a nota parou; API de contingência
```

1. **Checa.** Lista os XMLs no SFTP e pega, no relatório do ML, a última NF autorizada de cada série (o **teto**). Toda a numeração de `nota_inicial` até o teto precisa estar no FTP.
2. **Diagnostica cada furo.** Consulta o Nerus para saber em que etapa a nota parou e decide: contingência, esperar o envio, rechecar o FTP ou chamar o time técnico.
3. **Espera e confere.** O n8n espera 2 ou 10 min e o monitor reconfere o FTP do lote inteiro.
4. **Avisa.** Um relatório por NF, com o resultado, a causa, o que o monitor fez e o que fazer.

O painel web mostra o estado a cada 5 min e guarda o histórico de cada dia.

### Glossário

| Termo | Significado |
|---|---|
| Série | Numeração fiscal da NF-e. Cada série tem a sua sequência |
| Teto | Maior número autorizado no ML no dia: até onde a sequência precisa estar completa |
| Furo | Número entre `nota_inicial` e o teto que não está no FTP |
| Lote | Os furos de um ciclo, conferidos juntos |
| Contingência | Reenviar ao Nerus o aviso que o ML não mandou. **Ação real** |
| Nerus | Gateway fiscal que recebe o aviso do ML, registra a nota e envia o XML ao FTP |
| Cobertura degradada | A checagem rodou, mas está cega numa parte (ex.: sem teto do ML). Nunca aparece como verde |

## Mapa do repositório

```
monitoramento/        serviço Node 22 + TypeScript (a regra inteira)
  src/                um módulo por responsabilidade + *.test.ts ao lado
  config.example.yml  modelo do config.yml (cliente, SFTP, séries)
workflows/            workflows do n8n (JSON para importar)
docs/                 documentação por camada (ver abaixo)
secrets/              chave SSH do bastion (fora do Git)
docker-compose.yml    stack base (local e VPS)
docker-compose.prod.yml  overlay da VPS: Traefik/HTTPS + contingência ligada
.env.example          modelo do .env (segredos, fora do Git)
.github/workflows/    CI: typecheck + testes em todo PR
```

## Rodar localmente

**Pré-requisitos:** Docker com Compose e, para rodar os testes fora do container, Node 22. As credenciais (SFTP, ML, Nerus, chave SSH) vêm do responsável pelo projeto. Elas **nunca** vão para o Git.

> ⚠️ **Antes do primeiro `up`:**
> - Deixe `CONTINGENCIA=off`, que já é o padrão. Com `on`, o monitor renotifica o gateway fiscal **de verdade**.
> - **Nunca** use o `ML_REFRESH_TOKEN` da produção. Ele é de uso único: a primeira renovação na sua máquina derruba a VPS. Deixe vazio (o monitor roda só com o FTP, em "cobertura parcial") ou use um token próprio.

```bash
cp .env.example .env                                   # preencha; nunca commite
cp monitoramento/config.example.yml monitoramento/config.yml
# chave SSH do bastion em secrets/bastion.pem (chmod 600), se for diagnosticar no Nerus

docker compose up -d --build
docker compose logs --tail 20 monitor-sftp
```

**Deu certo se** o log mostra `monitor-sftp pronto :8080` e `Contingência desligada`, e o painel abre:

| Serviço | URL |
|---|---|
| Painel | http://localhost:8081/painel?token=SEU_MONITOR_HTTP_TOKEN |
| n8n | http://localhost:5678 |
| Monitor (para o n8n) | http://monitor-sftp:8080 |

Para importar os workflows no n8n local, use `docker compose run --rm --no-deps n8n import:workflow --input=/files/workflows/monitor-sftp.json` (e o mesmo com `error-handler.json`). Os detalhes estão em [docs/n8n.md](docs/n8n.md).

Testes: `cd monitoramento && npm run check`, com typecheck e testes, o mesmo que o CI roda.

## Mudanças comuns

| Quero… | Onde | Como validar |
|---|---|---|
| Mudar o texto de um aviso | `monitoramento/src/relatorio.ts` (resumo, lote, conferência) e `concluirRelatorio` em `diagnostico.ts` (diagnóstico de uma NF) | `npm run check`. Os testes de `ciclo.test.ts` e `diagnostico.test.ts` conferem trechos do texto |
| Adicionar uma série | `series[]` no `monitoramento/config.yml`. `nota_inicial` = primeira NF que precisa estar no FTP | `docker compose restart monitor-sftp` e conferir a série no painel |
| Mudar uma regra de decisão | `decidirAcao` em `diagnostico.ts`, `rodarCiclo` em `ciclo.ts` | Escreva o teste primeiro e depois rode `npm run check` |
| Ver um furo sem esperar um real | `FAKE_NOTA=99999/2` no `.env`, com `CONTINGENCIA=off` | Recrie o monitor, confira o painel e volte para vazio |
| Mudar o workflow do n8n | `workflows/*.json`. Sem regra em nó Code | [docs/n8n.md](docs/n8n.md) |
| Colocar em produção | [docs/deploy.md](docs/deploy.md) | O CI tem que estar verde no PR |

## Configuração

Tudo que identifica o cliente fica no `.env` e no `monitoramento/config.yml`, ambos fora do Git. Os arquivos `.example` usam só valores fictícios e comentam cada variável. As que mais importam:

| Variável | Uso |
|---|---|
| `MONITOR_HTTP_TOKEN` | Token entre o n8n e o monitor. **Obrigatório**: sem ele, o monitor recusa tudo, menos `/health` |
| `CONTINGENCIA` | Só `on` renotifica. Vazio = desligada. O `docker-compose.prod.yml` liga na VPS |
| `ML_CLIENT_ID` / `ML_CLIENT_SECRET` / `ML_REFRESH_TOKEN` / `ML_USER_ID` | OAuth e seller do ML. O refresh é de uso único |
| `NERUS_*` | SSH, MySQL e API do gateway (diagnóstico e contingência) |
| `ML_TETO_CACHE_MIN` | Cache do ZIP do ML, em minutos (padrão 5). Suba se aparecer 429 |
| `PAINEL_INTERVALO_MIN` | Checagem do painel, em minutos (padrão 5; `0` desliga) |
| `FAKE_NOTA` | Força um furo de teste. Vazio em produção |
| `MODO_AGENDA` / `AGENDA_CICLO` | Agenda do ciclo no próprio monitor: `off` (o n8n agenda), `sombra` (compara sem agir) ou `ativo` (substitui o n8n). Ver [docs/monitor.md](docs/monitor.md#agenda-e-avisos-migração-para-fora-do-n8n) |
| `SMTP_*` | E-mail dos avisos quando o monitor avisa sozinho (`MODO_AGENDA=ativo`) |

Depois de mudar o `.env`: `docker compose up -d --force-recreate monitor-sftp n8n`. Depois de mudar o `config.yml`: `docker compose restart monitor-sftp`.

## Produção

Siga **[docs/deploy.md](docs/deploy.md)**: acessos, o que nunca fazer, deploy, troca de workflow na ordem certa, teste de fumaça, rollback e recuperação do token do ML. Na VPS, o overlay `docker-compose.prod.yml` é obrigatório. Coloque `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml` no `.env` do servidor.

## Problemas comuns

| Sintoma | Causa | O que fazer |
|---|---|---|
| `EISDIR` na subida | Faltava `.env`, `config.yml` ou `bastion.pem`, e o Docker criou uma **pasta** no lugar | Apague a pasta, copie o `.example` e suba de novo |
| `401` "defina MONITOR_HTTP_TOKEN" | Token ausente no `.env` | Gere com `openssl rand -hex 32` e recrie o monitor e o n8n |
| `Cannot parse privateKey` | `secrets/bastion.pem` vazio ou inválido | Coloque a chave real (`chmod 600`) |
| Painel "Checagem incompleta", aviso "Teto ML indisponível" | ML fora, 429 ou token do ML inválido | 429: suba `ML_TETO_CACHE_MIN`. Token morto: [deploy.md](docs/deploy.md#5-o-token-do-mercado-livre-morreu) |
| Painel "Painel sem conexão com o monitor" | Container parado ou token errado na URL | `docker compose ps` e confira o `?token=` |
| Log diz `Contingência desligada` na VPS | Subiu sem o overlay de produção | Use `COMPOSE_FILE` (seção Produção) e recrie |
| NF "não encontrada no relatório do Mercado Livre" | A NF não está no ZIP do mês (número errado ou nota de outra conta) | Confira a NF no ML; o time técnico investiga |

## Limites conhecidos

- Sem teto do ML (sem token ou sem emissão no dia), o limite cai no máximo do FTP, e furos no fim da sequência ficam invisíveis. Por isso o status vira "cobertura parcial".
- `GET /users/{id}/invoices/search` do ML retorna 403. O `invoice_id` sai do ZIP ([ADR-001](docs/decisions/0001-relatorio-zip-em-vez-de-search.md)).
- O agendamento é seg–sex, das 8h às 18h. Um furo fora desse horário só é avisado no próximo ciclo; o painel continua checando.

## Documentação

| Camada | Documento |
|---|---|
| Regra de negócio (teto, furos, decisão, contingência, relatório) | [docs/regra-de-negocio.md](docs/regra-de-negocio.md) |
| Orquestração (workflows n8n, nó a nó) | [docs/n8n.md](docs/n8n.md) |
| Serviço monitor (módulos, fluxo de uma chamada, testes) | [docs/monitor.md](docs/monitor.md) |
| Integrações (SFTP, Mercado Livre, Nerus) | [docs/integracoes.md](docs/integracoes.md) |
| Painel e histórico | [docs/painel.md](docs/painel.md) |
| Contrato HTTP | [docs/api.md](docs/api.md) |
| Infra, deploy e recuperação | [docs/deploy.md](docs/deploy.md) |
| Decisões (por que é assim) | [docs/decisions/](docs/decisions/) |
| Contexto para sessões de análise | [PROJECT-CONTEXT.md](PROJECT-CONTEXT.md) |
