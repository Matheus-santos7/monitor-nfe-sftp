# Deploy, operação e recuperação

Não existe staging. Cada passo abaixo age no cliente real. Siga a ordem e não pule a verificação no final de cada etapa.

## Antes de começar

Você precisa de:

| Acesso | Para quê |
|---|---|
| SSH na VPS | rebuild do monitor e leitura dos logs |
| `.env` e `monitoramento/config.yml` da VPS | ficam só no servidor, nunca no Git |
| App do Mercado Livre (client id e secret) | só para recuperar o token (ver o fim desta página) |

Se faltar algum desses acessos, pare e peça ao responsável pelo projeto. Não tente contornar.

## Como a infraestrutura está montada

É um serviço só, o `monitor-sftp`, em Docker Compose. Cada cliente tem a sua instalação (pasta, `.env`, `config.yml`).

| Arquivo | Quando entra | O que define |
|---|---|---|
| `docker-compose.yml` | sempre, local e na VPS | O `monitor-sftp`, com a porta só em `127.0.0.1:8081`. Padrões seguros: `MODO_AGENDA=sombra` e `CONTINGENCIA=off` |
| `docker-compose.prod.yml` | só na VPS, junto com o base | `MODO_AGENDA=ativo` (agenda e avisos de verdade) e `CONTINGENCIA=on` |

Na VPS, ponha `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml` no `.env`. Com isso, todo `docker compose …` usa os dois arquivos. Sem o overlay, o monitor roda em sombra, sem avisar ninguém, e **sem dar erro nenhum**.

O que fica no disco do host, fora do Git:

| Caminho no host | No container | Conteúdo |
|---|---|---|
| `.env` | variáveis + `/app/.env.host` | Segredos. O monitor também grava ali o token do ML renovado |
| `monitoramento/config.yml` | `/app/config.yml` (só leitura) | Cliente, SFTP, séries |
| `monitoramento/data/` | `/app/data` | `historico/AAAAMMDD.json`, `ml-tokens.json` (token do ML, com prioridade sobre o `.env`) e `contingencias.json` (trava) |
| `secrets/bastion.pem` (ou `NERUS_SSH_KEY_HOST_PATH`) | `/run/secrets/bastion.pem` | Chave SSH do bastion do Nerus, `chmod 600` |

**Esses arquivos precisam existir antes do `up`.** Se faltar um deles, o Docker cria uma **pasta** com o mesmo nome, e o monitor falha com `EISDIR`. Apague a pasta, copie o `.example` e suba de novo.

## Nunca faça

- **Nunca use o `ML_REFRESH_TOKEN` da produção na sua máquina.** O refresh é de uso único: a primeira renovação local invalida o da VPS, e a produção fica sem o teto do ML.
- **Nunca rode dois monitores agendando para o mesmo cliente**, por exemplo dois servidores ou duas pastas. A contingência e os avisos sairiam em dobro. A trava de 30 min por invoice é só uma rede de proteção.
- **Nunca coloque `MODO_AGENDA=ativo` ou `CONTINGENCIA=on` fora da VPS.** Os padrões locais são `sombra` e `off`, e só o `docker-compose.prod.yml` liga os dois.
- **Nunca use o "Executar agora" em produção para "testar".** Ele roda o ciclo de verdade. Para testar, use a sua máquina (etapa 1).

## 1. Validar a mudança na sua máquina

```bash
cd monitoramento && npm run check     # typecheck + testes (o CI roda o mesmo)
cd .. && docker compose up -d --build monitor-sftp
docker compose logs --tail 20 monitor-sftp   # "Contingência desligada" e "Agenda do ciclo em SOMBRA"
```

Abra `http://localhost:8081/painel?token=<MONITOR_HTTP_TOKEN do seu .env>`. O **Executar agora** roda o ciclo inteiro em sombra: diagnostica, espera, confere e mostra os avisos no log, sem enviar.

Para ver um furo sem esperar um de verdade:

```bash
FAKE_NOTA=99999/2 docker compose up -d --force-recreate monitor-sftp   # série do seu config.yml, número que não existe
# painel: a NF 99999/2 aparece ausente; Executar agora → log "▶ [sombra] aviso não enviado: …"
docker compose up -d --force-recreate monitor-sftp                     # volta ao normal
```

## 2. Deploy na VPS

```bash
ssh <vps>
cd <pasta do projeto>
git fetch && git checkout <commit ou tag aprovado>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --remove-orphans
docker compose logs --tail 20 monitor-sftp
```

Verifique:

- O log mostra `monitor-sftp pronto`, `Contingência LIGADA` e `Agenda do ciclo ATIVA`. Se não mostrar "nenhum canal de aviso configurado", os canais estão definidos. Se aparecer "desligada" ou "SOMBRA", o overlay não entrou, ou o `.env` da VPS define `CONTINGENCIA` ou `MODO_AGENDA`: corrija antes de seguir.
- `curl -s http://127.0.0.1:8081/health` responde `{"ok":true,...}`.
- `curl -s -H "Authorization: Bearer $MONITOR_HTTP_TOKEN" http://127.0.0.1:8081/status` responde 200. Um 401 com a mensagem "defina MONITOR_HTTP_TOKEN" quer dizer que falta o token no `.env`.
- Painel: abra um túnel com `ssh -L 8081:127.0.0.1:8081 <vps>` e acesse `http://localhost:8081/painel?token=...` no seu navegador. A seção "Ciclo de monitoramento" deve mostrar "ativa" e o próximo horário.
- Na próxima hora cheia, o painel mostra o "Último ciclo", e os avisos chegam nos canais.

Mudou só o `config.yml`, por exemplo uma série nova? Rode `docker compose restart monitor-sftp`, sem rebuild. Mudou o `.env`? Rode `up -d --force-recreate monitor-sftp`.

**Pausar o monitor** (manutenção do gateway, por exemplo): coloque `MODO_AGENDA=off` no `.env` e recrie. Para manter os avisos e só desligar a contingência, use `CONTINGENCIA=off`.

## 3. Primeira vez sem n8n (servidor que ainda roda o n8n)

Siga isto uma vez, no servidor que ainda tem os containers `n8n`, `n8n-postgres` e `n8n-traefik`.

1. **Antes do deploy:**
   - Copie a credencial SMTP do n8n (Credentials) para `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` e `SMTP_PASS` no `.env`. Confira também `GOOGLE_CHAT_WEBHOOK_URL`, `WHATSAPP_*` e `ALERT_EMAIL_*`, que já estavam no `.env`.
   - Tire do `.env` qualquer `MODO_AGENDA` e `CONTINGENCIA` que impeçam os padrões de produção.
   - Se quiser guardar o histórico de execuções do n8n, exporte agora pelo editor.
2. Faça o deploy da etapa 2. O `--remove-orphans` **para e remove os containers** do n8n, do Postgres e do Traefik, que não estão mais no compose. Isso evita dois agendadores. Depois, confira com `docker ps` que só sobrou o `n8n-monitor-sftp`.
3. Rode **Executar agora** no painel e confira se os avisos chegam nos três canais.
4. Os volumes `n8n_n8n_data`, `n8n_postgres_data` e `n8n_traefik_data` continuam no disco. Depois de uma semana estável, apague-os se quiser: `docker volume rm …`.

O nome do projeto continua `n8n` de propósito: assim o container do monitor e a pasta `data/` continuam os mesmos.

## 4. Rollback

1. `git checkout <commit anterior>` e repita o deploy da etapa 2.
2. Se voltar para antes da saída do n8n (commits anteriores a esta branch), o compose antigo sobe de novo o n8n, o Postgres e o Traefik, com os volumes que ficaram no disco. Reative o workflow no editor, se ele não voltar ativo, e confira que o monitor antigo não está agendando: no compose antigo, `MODO_AGENDA` é `off`.

## 5. O token do Mercado Livre morreu

Os sinais são estes: o painel mostra "Teto ML indisponível: Falha ao renovar ML_ACCESS_TOKEN", e os avisos dizem "cobertura parcial". O monitor continua funcionando, mas só com o FTP: furos no fim da sequência ficam invisíveis.

1. No navegador, logado com a conta do vendedor, abra `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=<ML_CLIENT_ID>&redirect_uri=<redirect cadastrado no app>`. Autorize e copie o `code` que volta na URL.
2. Troque o code por tokens:
   ```bash
   curl -s -X POST https://api.mercadolibre.com/oauth/token \
     -d grant_type=authorization_code -d client_id=<ML_CLIENT_ID> -d client_secret=<ML_CLIENT_SECRET> \
     -d code=<code> -d redirect_uri=<redirect cadastrado no app>
   ```
3. Coloque o `access_token` e o `refresh_token` da resposta em `ML_ACCESS_TOKEN` e `ML_REFRESH_TOKEN` no `.env` da VPS.
4. **Apague `monitoramento/data/ml-tokens.json`.** Esse arquivo tem prioridade sobre o `.env`. Se ficar, o monitor continua tentando o token morto.
5. Rode `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate monitor-sftp`. No log, deve aparecer `token ML renovado` na próxima checagem.
