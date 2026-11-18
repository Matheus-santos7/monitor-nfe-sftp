# Camada de orquestração: n8n

O n8n agenda, espera e envia os avisos. **Ele não decide nada:** a regra inteira fica no monitor ([ADR-004](decisions/0004-regra-no-monitor-n8n-so-orquestra.md)). Os workflows ficam em `workflows/` e entram no n8n por import. O que está no editor de produção precisa ser igual ao JSON do repositório.

## Workflows

| Arquivo | Nome no n8n | Papel |
|---|---|---|
| `workflows/monitor-sftp.json` | **1. Monitor SFTP NF-e (ciclo)** | O ciclo de monitoramento |
| `workflows/error-handler.json` | **0. Error Handler — Monitor NF-e** | Avisa quando uma execução do ciclo falha |

Os dois entram **inativos** no import. O Error Handler precisa ser escolhido em Settings → Error workflow do workflow do ciclo.

## Monitor SFTP NF-e (ciclo), nó a nó

```
Agendar checagem (0 8-18 * * 1-5) ─┐
Executar agora (manual) ───────────┴─► Ciclo de monitoramento  POST /ciclo
                                          │
                                 Há lote para conferir?
                            não ┌─────────┴─────────┐ sim
                                │           Esperar o lote (10 min / 2 min)
                                │           Conferir lote no FTP  POST /ciclo/conferir
                                │           Ainda faltam no FTP?
                                │         não ┌─────┴─────┐ sim
                                │             │   Esperar 2 min (conferência)
                                │             │   Conferir lote de novo  POST /ciclo/conferir
                                ▼             ▼           ▼
                           Uma mensagem por aviso  (separa mensagens[])
                                │
              Avisar Google Chat · Avisar e-mail · Avisar WhatsApp
```

| Nó | O que faz | Em caso de erro |
|---|---|---|
| Agendar checagem | Cron `0 8-18 * * 1-5`, no fuso do workflow (America/Sao_Paulo) | — |
| Ciclo de monitoramento | `POST /ciclo` com `{execucao}` e Bearer `$env.MONITOR_HTTP_TOKEN`. Timeout de 600 s, **sem retry** | Para e chama o Error Handler |
| Há lote para conferir? | `lote.length > 0` | — |
| Esperar o lote | 600 s se `espera=10min`, 120 s se `2min` | — |
| Conferir lote no FTP / de novo | `POST /ciclo/conferir` com `notas` e `lote`, que vêm do nó do ciclo. Timeout de 180 s, 3 tentativas | Para e chama o Error Handler |
| Ainda faltam no FTP? | `aindaFaltam` | — |
| Uma mensagem por aviso | Split Out do campo `mensagens` (`{assunto, mensagem}`) | — |
| Avisar Google Chat / e-mail / WhatsApp | Envia `mensagem` em cada canal | **Continua**: um canal que falha não bloqueia os outros |

**Por que o `/ciclo` não tem retry:** repetir a chamada repete a contingência. O monitor tem uma trava de 30 min por invoice, mas ela é uma rede de proteção, não um convite para retry. As conferências só leem, então podem repetir.

**Limitação conhecida:** se os três canais falharem ao mesmo tempo, a execução termina verde sem ninguém avisado. É o custo de um canal com falha não bloquear os outros.

## Error Handler

`Falha no workflow` (Error Trigger) → `Montar alerta de falha` (nó Code, monta o texto a partir do erro) → envia nos mesmos três canais. Ele só dispara se estiver selecionado em Settings → Error workflow do ciclo.

## Variáveis que o n8n usa

Os nós leem o ambiente do container via `$env`. O `docker-compose.yml` repassa estas do `.env`:

| Variável | Usada em |
|---|---|
| `MONITOR_HTTP_TOKEN` | Header Bearer nas chamadas ao monitor |
| `GOOGLE_CHAT_WEBHOOK_URL` | Avisar Google Chat (`{text}`) |
| `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO` | Avisar e-mail. A credencial SMTP fica no próprio n8n, não no repositório |
| `WHATSAPP_WEBHOOK_URL` / `WHATSAPP_TO` | Avisar WhatsApp (`{number, text}`) |

Depois de mudar o `.env`: `docker compose up -d --force-recreate n8n`.

## Como alterar um workflow

1. Edite no n8n **local**, exporte e substitua o JSON em `workflows/`. Se editar o JSON direto, confira que continua válido: o CI testa isso.
2. **Não coloque regra em nó Code.** Se o fluxo precisar de uma decisão nova, ela vai para o monitor, com teste.
3. Em produção, importe e troque seguindo [deploy.md](deploy.md#3-trocar-o-workflow-no-n8n-primeira-vez-ou-json-alterado).

Regras que não mudam:

- **Um único workflow de monitoramento ativo por cliente.** Com dois ativos, a contingência roda em dobro.
- Importe com `docker compose run --rm --no-deps n8n import:workflow --input=/files/workflows/<arquivo>.json`. **Não** use `docker exec n8n n8n import:workflow`, porque sobe um segundo processo no mesmo container.
- O `id` no JSON identifica o workflow. Importar um JSON com o mesmo `id` atualiza o que já existe no n8n.
