# Deploy no servidor AWS, operação e recuperação

O projeto inteiro sobe com **um** `docker-compose.yml` e é acompanhado com `docker compose logs`. Não existe staging: o servidor age no cliente real. Siga a ordem e não pule as verificações.

## Como está montado

```
Internet ── 443/80 ──► proxy (Caddy, HTTPS automático)
                          ├─ https://PAINEL_HOST ──► painel (nginx)  ── /status, /historico, /ciclo/agora ──► api
                          └─ https://API_HOST    ──► api (Node)      ── SFTP, Mercado Livre, Nerus, avisos
```

| Serviço | Container | Porta no servidor | Papel |
|---|---|---|---|
| `api` | `monitor-api` | `127.0.0.1:8081` (`API_PORTA`) | Backend: API, agenda do ciclo, avisos |
| `painel` | `monitor-painel` | `127.0.0.1:8080` (`PAINEL_PORTA`) | Frontend: painel e histórico |
| `proxy` | `monitor-proxy` | `80` e `443`, públicas | HTTPS e um DNS por serviço |

As portas 8080 e 8081 só aceitam conexão do próprio servidor (para `curl` ou túnel SSH). De fora, o acesso é sempre pelo proxy, com HTTPS.

**Quem acessa o quê:**

| Quem | Link | Pode |
|---|---|---|
| Time técnico | `https://PAINEL_HOST`: login com conta **operacao** | Ver tudo e usar o **Executar agora** |
| Cliente (e quem só acompanha) | `https://PAINEL_HOST`: login com conta **leitura** | Ver o painel e o histórico. O botão não aparece, e a API recusa com 403 |
| Integrações e scripts | `https://API_HOST/…`, com `Authorization: Bearer <MONITOR_HTTP_TOKEN>` | Tudo. Não há login nem cookie por este endereço |

Ninguém recebe token no link. Cada pessoa tem a própria conta, criada com `node dist/senha.js` (seção 3), e a sessão dura 12 h num cookie HttpOnly.

## Antes de começar

| Item | Por quê |
|---|---|
| Servidor Linux com Docker Engine e o plugin compose v2 (`docker compose version`) | Roda tudo |
| **IP fixo (Elastic IP)** no servidor | DNS e liberação de IP |
| **Esse IP liberado no SFTP do cliente e no bastion SSH do Nerus** | Esses dois costumam aceitar só IPs conhecidos. Sem liberação, o monitor não lista os XMLs nem diagnostica |
| Dois registros DNS do tipo A, `PAINEL_HOST` e `API_HOST`, apontando para o IP | O Caddy só emite o certificado se o nome já resolver para o servidor |
| Security Group: entrada **80 e 443** (de qualquer lugar, se o cliente acessa de fora); **22** só da rede do setor. **Não** abra 8080/8081 | HTTPS público; o resto fechado |
| Saída liberada: 443 (Mercado Livre, Let's Encrypt, Nerus API, webhooks), 22 (SFTP e bastion), 587/465 (SMTP) | O monitor fala com tudo isso |
| O `.env`, o `config.yml`, a chave `bastion.pem` e a pasta `monitoramento/data/` do servidor atual | Credenciais, histórico e o token do ML em uso |

## Nunca faça

- **Nunca deixe dois servidores rodando o monitor do mesmo cliente** (o antigo e o novo). O token do ML é de uso único, e os dois brigariam por ele. A contingência e os avisos sairiam em dobro.
- **Nunca use o `ML_REFRESH_TOKEN` da produção na sua máquina.** A primeira renovação local invalida o do servidor.
- **Nunca crie conta `operacao` para o cliente.** Para ele, só `leitura`. E nunca mande o `MONITOR_HTTP_TOKEN` para ninguém de fora do time técnico.
- **Nunca compartilhe uma conta entre pessoas.** O log registra quem entrou e quem apertou **Executar agora**.
- **Nunca coloque `MODO_AGENDA=ativo` ou `CONTINGENCIA=on` fora do servidor.**
- **Nunca abra 8080/8081 no Security Group.** Elas não têm HTTPS.

## 1. Instalação no servidor (primeira vez)

O servidor **não precisa do código**: as imagens (`api`, `painel`, `proxy`) são publicadas pelo CI no GitHub Container Registry a cada merge na `main`, e o servidor só as baixa. Na pasta do servidor ficam apenas estes arquivos:

```
monitor-nfe/
├── docker-compose.yml          # baixado do repositório (é o único arquivo do projeto)
├── .env                        # segredos e configuração (chmod 600)
├── monitoramento/
│   ├── config.yml              # cliente, SFTP, séries
│   └── data/                   # histórico, token do ML em uso, trava da contingência
└── secrets/
    └── bastion.pem             # chave SSH do Nerus (chmod 600)
```

```bash
ssh <servidor>
mkdir -p ~/monitor-nfe/monitoramento/data ~/monitor-nfe/secrets && cd ~/monitor-nfe
curl -fsSLO https://raw.githubusercontent.com/Matheus-santos7/monitor-nfe-sftp/main/docker-compose.yml
```

Vindo da sua máquina, que hoje é a produção, siga a **seção 4 (migração)**: ela traz o `.env`, o `config.yml`, a chave e o `data/`. Numa instalação do zero, use o `.env.example` e o `config.example.yml` do repositório como modelo.

No `.env` do servidor, além das credenciais (ML, Nerus, canais de aviso):

```
MODO_AGENDA=ativo
CONTINGENCIA=on
PAINEL_HOST=monitor.seusetor.com.br
API_HOST=api-monitor.seusetor.com.br
MONITOR_VERSAO=latest                       # ou uma versão fixa, ex.: sha-531971d (ver seção 5)
MONITOR_HTTP_TOKEN=<openssl rand -hex 32>   # Bearer da API, só scripts do time técnico
SESSAO_SEGREDO=<openssl rand -hex 32>       # assina o cookie de login
PAINEL_USUARIOS=                            # contas (seção 3), separadas por vírgula
```

**Se as imagens estiverem privadas** no GitHub (Packages), faça uma vez no servidor: `docker login ghcr.io -u <usuario-github>`, usando um token com permissão só `read:packages`. Se estiverem públicas, nada é preciso.

## 2. Subir e verificar

```bash
docker compose pull               # baixa as imagens da versão MONITOR_VERSAO
docker compose up -d
docker compose ps                 # api, painel e proxy "running" / "healthy"
docker compose logs -f            # Ctrl+C sai sem parar nada
```

O que precisa aparecer nos logs:

- `monitor-api`: `monitor-sftp pronto`, `Contingência LIGADA` e `Agenda do ciclo ATIVA`. Não pode aparecer "nenhum canal de aviso configurado". Se aparecer "desligada" ou "SOMBRA", falta `CONTINGENCIA=on` ou `MODO_AGENDA=ativo` no `.env`.
- `monitor-proxy`: `certificate obtained successfully` para os dois nomes. Se aparecer um erro de ACME, o DNS ainda não aponta para o servidor, ou a porta 80/443 está fechada.

Testes:

```bash
curl -s https://API_HOST/health                                               # {"ok":true,...}
curl -s -H "Authorization: Bearer $MONITOR_HTTP_TOKEN" https://API_HOST/status | head -c 200
curl -s -o /dev/null -w "%{http_code}\n" https://API_HOST/login                        # 404: login só pelo painel
```

Crie as contas (seção 3), abra `https://PAINEL_HOST` e entre com uma conta `operacao`. No log da `api`, deve aparecer `▶ Login: <usuário> (operacao)`. A seção "Ciclo de monitoramento" deve mostrar "ativa" e o próximo horário. Use o **Executar agora** e confira que os avisos chegam nos canais.

## 3. Operação do dia a dia

| Quero… | Comando |
|---|---|
| Ver os logs ao vivo | `docker compose logs -f`, ou só um serviço: `docker compose logs -f api` |
| Ver a última hora | `docker compose logs --since 1h api` |
| Ver o estado dos containers | `docker compose ps` |
| **Atualizar para uma versão nova** (depois do merge na `main` e do CI verde) | `docker compose pull && docker compose up -d`. Só os containers com imagem nova são recriados |
| Ver qual versão está rodando | `docker compose images` (a coluna TAG) ou `docker inspect monitor-api --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'` (o commit) |
| Atualizar o `docker-compose.yml` (raro; quando o PR mexer nele) | `curl -fsSLO https://raw.githubusercontent.com/Matheus-santos7/monitor-nfe-sftp/main/docker-compose.yml && docker compose up -d` |
| Aplicar uma mudança no `.env` | `docker compose up -d --force-recreate api` (ou `proxy`, se mudou `PAINEL_HOST`/`API_HOST`) |
| Aplicar uma mudança no `config.yml` (ex.: série nova) | `docker compose restart api` |
| Pausar o monitor (manutenção do gateway) | `MODO_AGENDA=off` no `.env` e recriar a `api`. O painel continua mostrando o estado |
| Manter os avisos, mas sem contingência | `CONTINGENCIA=off` no `.env` e recriar a `api` |
| **Criar a conta de uma pessoa** | `docker compose exec api node dist/senha.js <usuario> <leitura\|operacao>` (pede a senha, mínimo de 12 caracteres, sem eco). Acrescente a linha impressa em `PAINEL_USUARIOS` (separe as contas por vírgula) e recrie a `api` |
| Trocar a senha de alguém | Gere de novo com o mesmo usuário e substitua a linha. **As sessões abertas dessa pessoa caem na hora** |
| Tirar o acesso de alguém | Apague a linha da pessoa em `PAINEL_USUARIOS` e recrie a `api`. A sessão dela para de valer |
| Derrubar todas as sessões (suspeita de vazamento) | Gere um novo `SESSAO_SEGREDO` e recrie a `api`. Todo mundo entra de novo |
| Trocar o token da API (scripts) | Gere um novo `MONITOR_HTTP_TOKEN`, troque no `.env` e nos scripts, recrie a `api` |
| Ver quem entrou e quem operou | `docker compose logs api \| grep -E "Login\|Executar agora"` |

Os logs giram sozinhos: são 10 MB × 5 arquivos por serviço.

## 4. Migração da sua máquina para o servidor AWS

Hoje a produção roda na sua máquina. É nela que estão o token do ML em uso, a trava da contingência e o histórico. A ordem existe por causa do token do ML de uso único e da contingência.

1. Confirme no servidor: **IP fixo**, Security Group (80/443), os dois registros DNS A apontando para ele, e **o IP liberado no SFTP do cliente e no bastion do Nerus**. Se der, teste do servidor: `ssh -i bastion.pem ec2-user@<bastion> exit`.
2. **Na sua máquina, pare tudo:** `docker compose down`. Daqui em diante, nada renova o token nem agenda ciclos ali.
3. Copie da sua máquina para o servidor:
   ```bash
   cd ~/Projetos/monitor-nfe-sftp
   scp .env <servidor>:~/monitor-nfe/.env
   scp monitoramento/config.yml <servidor>:~/monitor-nfe/monitoramento/config.yml
   scp secrets/bastion.pem <servidor>:~/monitor-nfe/secrets/bastion.pem
   scp -r monitoramento/data/. <servidor>:~/monitor-nfe/monitoramento/data/
   ssh <servidor> 'chmod 600 ~/monitor-nfe/.env ~/monitor-nfe/secrets/bastion.pem'
   ```
   A pasta `data/` é obrigatória: o `ml-tokens.json` tem o token do ML **atual**, com prioridade sobre o `.env`. Sem ele, o servidor sobe com um token que já não vale.
4. No `.env` do servidor, troque `PAINEL_HOST` e `API_HOST` pelos DNS reais. O resto (contas, `SESSAO_SEGREDO`, `MODO_AGENDA=ativo`, `CONTINGENCIA=on`) já vem pronto da sua máquina.
5. Suba e verifique (seção 2). As contas e as senhas do painel continuam as mesmas.
6. **Não religue a sua máquina** com `MODO_AGENDA=ativo`. Para desenvolver nela, tire `MODO_AGENDA` e `CONTINGENCIA` do `.env` local (volta a ser sombra/off) e use outro `ML_REFRESH_TOKEN`, ou deixe vazio.

## 5. Rollback

- **Para a versão anterior:** cada merge publica também uma tag `sha-<commit>`. No `.env`, coloque `MONITOR_VERSAO=sha-<commit anterior>` (veja as versões em GitHub → Packages) e rode `docker compose pull && docker compose up -d`. Para voltar a acompanhar a `main`: `MONITOR_VERSAO=latest`.
- **De volta para a sua máquina:**
  1. `docker compose down` no servidor.
  2. Copie a `monitoramento/data/` do servidor de volta para a sua máquina, porque o token do ML girou no servidor.
  3. Suba na sua máquina.

## 6. O token do Mercado Livre morreu

Os sinais são estes: o painel mostra "Teto ML indisponível: Falha ao renovar ML_ACCESS_TOKEN", e os avisos dizem "cobertura parcial". O monitor continua funcionando, mas só com o FTP: furos no fim da sequência ficam invisíveis.

1. No navegador, logado com a conta do vendedor, abra `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=<ML_CLIENT_ID>&redirect_uri=<redirect cadastrado no app>`. Autorize e copie o `code` que volta na URL.
2. Troque o code por tokens:
   ```bash
   curl -s -X POST https://api.mercadolibre.com/oauth/token \
     -d grant_type=authorization_code -d client_id=<ML_CLIENT_ID> -d client_secret=<ML_CLIENT_SECRET> \
     -d code=<code> -d redirect_uri=<redirect cadastrado no app>
   ```
3. Coloque o `access_token` e o `refresh_token` da resposta em `ML_ACCESS_TOKEN` e `ML_REFRESH_TOKEN` no `.env`.
4. **Apague `monitoramento/data/ml-tokens.json`.** Esse arquivo tem prioridade sobre o `.env`. Se ficar, o monitor continua tentando o token morto.
5. Rode `docker compose up -d --force-recreate api`. No log, deve aparecer `token ML renovado` na próxima checagem.

## Referência das variáveis do `.env`

Os comentários de cada uma estão no `.env.example`. "No servidor" significa obrigatória no servidor AWS e ausente na sua máquina.

<!-- AUTO-GENERATED: .env.example + padrões do docker-compose.yml — regenere com /ecc:update-docs -->
| Variável | Obrigatória | Padrão do compose | Para quê | Exemplo |
|---|---|---|---|---|
| `TZ` | Sim | nenhum (defina) | Fuso do monitor (agenda, histórico, horários) | `America/Sao_Paulo` |
| `PAINEL_HOST` | No servidor | `painel.localhost` | DNS do painel (o Caddy emite o HTTPS) | `monitor.seusetor.com.br` |
| `API_HOST` | No servidor | `api.localhost` | DNS da API | `api-monitor.seusetor.com.br` |
| `PAINEL_PORTA` | Não | `8080` | Porta do painel no próprio servidor (127.0.0.1) | `8080` |
| `API_PORTA` | Não | `8081` | Porta da API no próprio servidor (127.0.0.1) | `8081` |
| `HTTP_PORTA` | Não | `80` | Porta pública HTTP do proxy (redireciona para HTTPS) | `80` |
| `HTTPS_PORTA` | Não | `443` | Porta pública HTTPS do proxy | `443` |
| `GOOGLE_CHAT_WEBHOOK_URL` | Não¹ | vazio | Webhook do Google Chat (avisos) | `https://chat.googleapis.com/v1/spaces/…` |
| `ALERT_EMAIL_FROM` | Não | vazio | Remetente do e-mail (padrão: o próprio `ALERT_EMAIL_TO`) | `monitor@exemplo.com` |
| `ALERT_EMAIL_TO` | Não¹ | vazio | Destinatário do e-mail (exige `SMTP_HOST`) | `ops@exemplo.com` |
| `WHATSAPP_WEBHOOK_URL` | Não¹ | vazio | Webhook do WhatsApp (recebe `{number, text}`) | `https://…` |
| `WHATSAPP_TO` | Não | vazio | Número de destino do WhatsApp | `5511999999999` |
| `PAINEL_USUARIOS` | **Sim²** | vazio | Contas do painel, `usuario:papel:salt:hash` separadas por vírgula (gere com `node dist/senha.js`) | `ana:operacao:…:…,cliente:leitura:…:…` |
| `SESSAO_SEGREDO` | **Sim²** | vazio | Assina o cookie de login (mín. 32). Trocar derruba todas as sessões | `openssl rand -hex 32` |
| `MONITOR_HTTP_TOKEN` | Não | vazio | Bearer da API para scripts (só no header). Sem ele, a API não aceita Bearer | `openssl rand -hex 32` |
| `ML_ACCESS_TOKEN` | Não | vazio | Access token do ML (renovado sozinho; ~6 h) | `APP_USR-…` |
| `ML_REFRESH_TOKEN` | Recomendada³ | vazio | Refresh do ML, **uso único**. Nunca o da produção fora dela | `TG-…` |
| `ML_CLIENT_ID` | Recomendada³ | vazio | App do ML (OAuth). Também vira o `application_id` da contingência | `0000…` |
| `ML_CLIENT_SECRET` | Recomendada³ | vazio | Segredo do app do ML | `xxxx…` |
| `ML_USER_ID` | Recomendada³ | vazio | Seller do relatório fiscal | `0000000000` |
| `ML_APPLICATION_ID` | Não | — (não repassada) | **Ignorada pelo compose**: o compose repassa `ML_CLIENT_ID` no lugar | — |
| `ML_TETO_DIAS` | Não | `1` | Janela do teto em dias (1 = só hoje) | `1` |
| `FAKE_NOTA` | Não | vazio | Força um furo de teste. Vazio em produção | `99999/2` |
| `NERUS_TENANT_ID` | Recomendada⁴ | vazio | Tenant do cliente no Nerus | — |
| `NERUS_SSH_HOST` | Recomendada⁴ | vazio | Bastion SSH do Nerus | — |
| `NERUS_SSH_PORT` | Não | `22` | Porta do bastion | `22` |
| `NERUS_SSH_USER` | Recomendada⁴ | vazio | Usuário SSH do bastion | — |
| `NERUS_SSH_KEY_HOST_PATH` | Não | `./secrets/bastion.pem` | Caminho da chave no host | `./secrets/bastion.pem` |
| `NERUS_DB_HOST` | Recomendada⁴ | vazio | MySQL do Nerus (visto do bastion) | — |
| `NERUS_DB_PORT` | Não | `3306` | Porta do MySQL | `3306` |
| `NERUS_DB_USER` | Recomendada⁴ | vazio | Usuário MySQL (só leitura) | — |
| `NERUS_DB_PASSWORD` | Recomendada⁴ | vazio | Senha MySQL | — |
| `NERUS_USERNAME` | Recomendada⁵ | vazio | Login da API de contingência | — |
| `NERUS_PASSWORD` | Recomendada⁵ | vazio | Senha da API de contingência | — |
| `NERUS_AUTH_URL` | Recomendada⁵ | vazio | URL de login da API do Nerus | — |
| `NERUS_NOTIFICATION_URL` | Recomendada⁵ | vazio | URL de renotificação (contingência) | — |
| `PAINEL_INTERVALO_MIN` | Não | `5` | Checagem silenciosa do painel, em min (`0` desliga) | `5` |
| `ML_TETO_CACHE_MIN` | Não | `5` | Cache do ZIP do ML, em min. Suba se der 429 | `5` |
| `MODO_AGENDA` | No servidor | `sombra` | `off` · `sombra` · `ativo`. **Servidor: `ativo`** | `ativo` |
| `AGENDA_CICLO` | Não | `0 8-18 * * 1-5` | Cron do ciclo, fuso America/Sao_Paulo | `0 8-18 * * 1-5` |
| `SMTP_HOST` | Não¹ | vazio | Servidor SMTP (sem ele, não envia e-mail) | `smtp.exemplo.com` |
| `SMTP_PORT` | Não | `587` | Porta SMTP (465 liga TLS direto) | `587` |
| `SMTP_SECURE` | Não | vazio | `true` para TLS direto | vazio |
| `SMTP_USER` | Não | vazio | Usuário SMTP | — |
| `SMTP_PASS` | Não | vazio | Senha SMTP | — |
| `CONTINGENCIA` | No servidor | `off` | `on` renotifica o gateway **de verdade**. **Servidor: `on`**; fora dele, nunca | `on` |

¹ Pelo menos **um** canal de aviso no servidor (Chat, WhatsApp ou e-mail com `SMTP_HOST` + `ALERT_EMAIL_TO`); o log da subida avisa se nenhum estiver configurado.
² Sem `SESSAO_SEGREDO` o login fica desligado; sem `PAINEL_USUARIOS` ninguém entra. O log da subida avisa os dois casos.
³ Sem as credenciais do ML não há teto: o monitor roda só com o FTP e o painel mostra "cobertura parcial".
⁴ Sem elas não há diagnóstico no Nerus: cada furo sai "Não foi possível consultar o Nerus".
⁵ Sem elas a contingência falha (o relatório pede o time técnico).
<!-- /AUTO-GENERATED -->
