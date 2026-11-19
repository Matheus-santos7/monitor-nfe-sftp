# Deploy no servidor AWS, operação e recuperação

O projeto inteiro sobe com **um** `docker-compose.yml` e é acompanhado com `docker compose logs`. Não existe staging: o servidor age no cliente real. Siga a ordem e não pule as verificações.

## Como está montado

```
Internet ── 443/80 ──► proxy do servidor (já existente: nginx/Traefik…, ou o nosso Caddy)
                          ├─ https://PAINEL_HOST ──► 127.0.0.1:9080 painel (nginx) ── /status, /historico, /ciclo/agora ──► api
                          └─ https://API_HOST    ──► 127.0.0.1:9081 api (Node)     ── SFTP, Mercado Livre, Nerus, avisos
```

| Serviço | Container | Porta no servidor | Papel |
|---|---|---|---|
| `api` | `monitor-api` | `127.0.0.1:9081` | Backend: API, agenda do ciclo, avisos |
| `painel` | `monitor-painel` | `127.0.0.1:9080` | Frontend: painel e histórico |
| `proxy` (opcional) | `monitor-proxy` | `80` e `443` | HTTPS próprio. **Desligado** no servidor compartilhado (seção 1b) |

As portas 9080 e 9081 só aceitam conexão do próprio servidor. De fora, o acesso é sempre pelos DNS, com HTTPS, através do proxy do servidor.

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
| Dois registros DNS do tipo A, `PAINEL_HOST` e `API_HOST`, apontando para o IP do servidor (DNS não tem porta) | O certificado só é emitido se o nome já resolver para o servidor |
| Security Group: entrada **80 e 443** (de qualquer lugar, se o cliente acessa de fora; normalmente já abertas no servidor compartilhado); **22** só da rede do setor. **Não** abra 9080/9081 | HTTPS público; o resto fechado |
| Acesso para editar o proxy que já existe no servidor (seção 1b) | É ele que publica os dois DNS |
| Saída liberada: 443 (Mercado Livre, Let's Encrypt, Nerus API, webhooks), 22 (SFTP e bastion), 587/465 (SMTP) | O monitor fala com tudo isso |
| O `.env`, o `config.yml`, a chave `bastion.pem` e a pasta `monitoramento/data/` do servidor atual | Credenciais, histórico e o token do ML em uso |

## Nunca faça

- **Nunca deixe dois servidores rodando o monitor do mesmo cliente** (o antigo e o novo). O token do ML é de uso único, e os dois brigariam por ele. A contingência e os avisos sairiam em dobro.
- **Nunca use o `ML_REFRESH_TOKEN` da produção na sua máquina.** A primeira renovação local invalida o do servidor.
- **Nunca crie conta `operacao` para o cliente.** Para ele, só `leitura`. E nunca mande o `MONITOR_HTTP_TOKEN` para ninguém de fora do time técnico.
- **Nunca compartilhe uma conta entre pessoas.** O log registra quem entrou e quem apertou **Executar agora**.
- **Nunca coloque `MODO_AGENDA=ativo` ou `CONTINGENCIA=on` fora do servidor.**
- **Nunca abra 9080/9081 no Security Group.** Elas não têm HTTPS.

## 1. Instalação no servidor (primeira vez)

O servidor **não precisa do código nem de `.env`**: tudo fica num **único arquivo**, o modelo [`servidor/docker-compose.yml`](../servidor/docker-compose.yml). Ele guarda:
- as variáveis (no lugar do `.env`);
- o conteúdo do `config.yml` (em `configs:`);
- o **caminho da chave `.pem`** (em `secrets:`).

As imagens vêm prontas do GitHub Container Registry, e os dados (histórico, token do ML, trava) ficam num volume do Docker.

```
~/monitor-nfe/
└── docker-compose.yml     ← o único arquivo (chmod 600: tem senhas)
~/chaves/bastion.pem       ← a chave do Nerus, no caminho que você indicar em secrets: (chmod 600)
```

```bash
ssh <servidor>
docker compose version            # precisa ser 2.23.1 ou mais novo
mkdir -p ~/monitor-nfe ~/chaves && cd ~/monitor-nfe
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/Matheus-santos7/monitor-nfe-sftp/main/servidor/docker-compose.yml
chmod 600 docker-compose.yml
```

Preencha todos os `<…>` do arquivo:

| Onde no arquivo | O que vai |
|---|---|
| `x-enderecos` | Os dois DNS (`PAINEL_HOST`, `API_HOST`) |
| `environment` da `api` | O que antes ia no `.env`: contas, `SESSAO_SEGREDO`, `MONITOR_HTTP_TOKEN`, Google Chat, ML, Nerus. Já vem com `MODO_AGENDA: ativo` e `CONTINGENCIA: "on"` |
| `configs.config_monitor.content` | O que antes ia no `config.yml`: cliente, SFTP, séries |
| `secrets.bastion.file` | O caminho da chave no servidor (ex.: `/home/ec2-user/chaves/bastion.pem`) |

- Um valor com `$` (uma senha, por exemplo) precisa ser escrito como `$$`.
- Vindo da sua máquina, que hoje é a produção, siga a **seção 4**: ela traz também o token do ML em uso.
- **Se as imagens estiverem privadas** no GitHub (Packages), faça uma vez no servidor: `docker login ghcr.io -u <usuario-github>`, usando um token só com `read:packages`.

> O `docker-compose.yml` da raiz do repositório é o de **desenvolvimento** (usa `.env`, `config.yml` e compila o código). No servidor, use só o `servidor/docker-compose.yml`.

## 1b. Servidor compartilhado (o proxy que já existe faz o HTTPS)

No servidor compartilhado, as portas 80 e 443 já pertencem ao proxy das outras aplicações (nginx, Traefik, Apache…). Por isso o `servidor/docker-compose.yml` sobe só o **painel em `127.0.0.1:9080`** e a **API em `127.0.0.1:9081`**, e o proxy próprio (Caddy) fica desligado (`profiles: [proxy-proprio]`). Quem publica os dois DNS com HTTPS é o proxy que já existe:

```
https://PAINEL_HOST ──► proxy do servidor (443) ──► http://127.0.0.1:9080  (painel)
https://API_HOST    ──► proxy do servidor (443) ──► http://127.0.0.1:9081  (api, só Bearer)
```

Para descobrir quem ocupa as portas: `sudo ss -tlnp | grep -E ':(80|443|9080|9081) '`. As portas 9080 e 9081 **não** devem ser abertas no Security Group: elas só aceitam conexão do próprio servidor.

A configuração abaixo reproduz as proteções do nosso Caddy. **Não deixe de fora as linhas do `API_HOST`:** elas impedem o login e o cookie por esse endereço.

**nginx** (ex.: `/etc/nginx/conf.d/monitor-nfe.conf`; o certificado é o que o servidor já usa, ex.: certbot):

```nginx
server {
  listen 443 ssl;
  server_name monitor.seusetor.com.br;                 # = PAINEL_HOST
  ssl_certificate     /etc/letsencrypt/live/monitor.seusetor.com.br/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/monitor.seusetor.com.br/privkey.pem;
  add_header Strict-Transport-Security "max-age=86400" always;
  client_max_body_size 16k;
  location / {
    proxy_pass http://127.0.0.1:9080;
    proxy_set_header X-Forwarded-For $remote_addr;      # IP real (limite de login e auditoria)
    proxy_set_header Host $host;
  }
}

server {
  listen 443 ssl;
  server_name api-monitor.seusetor.com.br;             # = API_HOST
  ssl_certificate     /etc/letsencrypt/live/api-monitor.seusetor.com.br/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api-monitor.seusetor.com.br/privkey.pem;
  add_header Strict-Transport-Security "max-age=86400" always;
  client_max_body_size 16k;
  location ~ ^/(login|logout|sessao)$ { return 404; }  # login só pelo painel
  location / {
    proxy_pass http://127.0.0.1:9081;
    proxy_set_header Cookie "";                        # por aqui só Bearer, nunca sessão
    proxy_set_header X-Real-IP "";
  }
}
# HTTP → HTTPS (se o servidor ainda não tiver um redirecionamento geral)
server { listen 80; server_name monitor.seusetor.com.br api-monitor.seusetor.com.br; return 301 https://$host$request_uri; }
```

Teste com `sudo nginx -t && sudo systemctl reload nginx`. Para emitir os certificados: `sudo certbot --nginx -d monitor.seusetor.com.br -d api-monitor.seusetor.com.br`.

**Caddy** (se o proxy do servidor for um Caddy):

```
monitor.seusetor.com.br {
	header Strict-Transport-Security "max-age=86400"
	request_body { max_size 16KB }
	reverse_proxy 127.0.0.1:9080
}
api-monitor.seusetor.com.br {
	header Strict-Transport-Security "max-age=86400"
	@sessao path /login /logout /sessao
	respond @sessao 404
	reverse_proxy 127.0.0.1:9081 {
		header_up -Cookie
		header_up -X-Real-IP
	}
}
```

**Load balancer da AWS (ALB) na frente** (o caso do servidor de implantação: `curl -sI https://<dns>` mostra `server: awselb/2.0`, e o DNS devolve vários IPs). O ALB faz o HTTPS, com o certificado do ACM, e encaminha cada nome para uma porta do servidor. Nesse caso:

1. **Publique as portas para fora do container.** O ALB é outra máquina e não alcança `127.0.0.1`. No `docker-compose.yml` do servidor:
   ```yaml
   # api
       ports:
         - "9081:8080"
   # painel
       ports:
         - "9080:80"
   ```
2. **Security Group da instância:** libere a entrada nas portas **9080 e 9081 só a partir do Security Group do ALB**, nunca de `0.0.0.0/0`. Sem HTTPS, essas portas não podem ficar abertas para a internet.
3. **No ALB:** dois *target groups* apontando para a instância. Ajuste a regra de host do listener HTTPS (443) de cada um:

   | Regra de host do listener | Target group | Porta | Health check |
   |---|---|---|---|
   | `PAINEL_HOST` | painel | 9080 | `GET /` → 200 |
   | `API_HOST` | api | 9081 | `GET /health` → 200 |

   O listener HTTP (80) redireciona para HTTPS (o padrão do ALB).
4. **No `docker-compose.yml` do servidor,** `PAINEL_HOST` e `API_HOST` recebem os nomes reais do DNS. A proteção contra CSRF compara com o `PAINEL_HOST`, e o app reconhece o `API_HOST` pelo `Host` que o ALB repassa. Por esse endereço, o próprio app só aceita Bearer: o login, a sessão e o cookie ficam de fora, e o IP é a última entrada do `X-Forwarded-For`, que é a escrita pelo ALB. Nada disso depende de configurar o ALB.
5. Não precisa do proxy próprio nem da rede de outro projeto. Deixe `networks: [monitor]` na `api` e no `painel`.

O 502 do ALB quer dizer que o target está fora. Confira o health check do target group e se as portas estão publicadas fora do `127.0.0.1` (`sudo ss -tlnp | grep -E ':(9080|9081) '` deve mostrar `0.0.0.0`).

**Caddy de outro projeto, em container** (o caso do servidor de implantação: `docker ps` mostra um `…-caddy-1` nas portas 80/443):

1. Descubra a rede do Caddy e onde está o Caddyfile dele:
   ```bash
   docker inspect <container-caddy> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
   docker inspect <container-caddy> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
   ```
2. No `docker-compose.yml` do monitor, ponha a `api` e o `painel` também nessa rede: descomente `proxy_servidor` em `networks:`, com o nome da rede, e use `networks: [monitor, proxy_servidor]` nos dois serviços. Suba com `docker compose up -d`.
3. Faça uma cópia do Caddyfile do outro projeto (o arquivo do host, do passo 1) e **acrescente no fim** os dois blocos. Por aqui, o Caddy alcança o monitor pelo nome do container:
   ```bash
   cp <Caddyfile> <Caddyfile>.bak-$(date +%F)
   cat >> <Caddyfile> <<'CADDY'

   # --- Monitor NF-e ---
   monitor.seusetor.com.br {
   	header Strict-Transport-Security "max-age=86400"
   	request_body {
   		max_size 16KB
   	}
   	reverse_proxy monitor-painel:80
   }
   api-monitor.seusetor.com.br {
   	header Strict-Transport-Security "max-age=86400"
   	@sessao path /login /logout /sessao
   	respond @sessao 404
   	reverse_proxy monitor-api:8080 {
   		header_up -Cookie
   		header_up -X-Real-IP
   	}
   }
   CADDY
   ```
   Use `cat >>`, que escreve no mesmo arquivo. Um editor que **substitui** o arquivo faz o container continuar vendo o Caddyfile antigo, porque o bind mount fica preso ao arquivo original.
4. Valide e recarregue, **sem reiniciar** o outro sistema. O `reload` é sem queda, e com erro de configuração o Caddy mantém a anterior:
   ```bash
   docker exec <container-caddy> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker exec <container-caddy> caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   docker logs --since 2m <container-caddy> 2>&1 | grep -iE "monitor|certificate|error"
   ```
   O Caddy emite o certificado dos dois nomes na hora, desde que os registros DNS já apontem para o servidor. Para desfazer: volte o `.bak` e rode o `reload` de novo.

**Outro proxy em Docker** (Traefik ou nginx num container): `127.0.0.1` dentro dele não é o servidor. Duas saídas:
- trocar `127.0.0.1` por `host.docker.internal` (com `extra_hosts: ["host.docker.internal:host-gateway"]` no proxy) e publicar as portas do monitor em `0.0.0.0:9080`/`0.0.0.0:9081`, deixando 9080/9081 fechadas no Security Group;
- ou colocar o proxy na rede `monitor-nfe_monitor` e apontar para `painel:80` e `api:8080`.

**Se nada usa 80/443 no servidor**, dá para usar o proxy próprio: apague a linha `profiles: [proxy-proprio]` do serviço `proxy` e rode `docker compose up -d`. Ele emite o HTTPS sozinho, e esta seção inteira deixa de ser necessária.

## 2. Subir e verificar

```bash
docker compose pull               # baixa as imagens da versão MONITOR_VERSAO
docker compose up -d
docker compose ps                 # api e painel "running" / "healthy" (e proxy, se ligou o próprio)
docker compose logs -f            # Ctrl+C sai sem parar nada
```

O que precisa aparecer nos logs:

- `monitor-api`: `monitor-sftp pronto`, `Contingência LIGADA` e `Agenda do ciclo ATIVA`. Não pode aparecer "nenhum canal de aviso configurado". Se aparecer "desligada" ou "SOMBRA", confira `CONTINGENCIA: "on"` e `MODO_AGENDA: ativo` no `docker-compose.yml`.
- Direto no servidor: `curl -s http://127.0.0.1:9081/health` responde `{"ok":true,...}`, e `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9080/` responde `200`. Se isso funciona e o DNS não, o problema está no proxy do servidor (seção 1b).
- Se ligou o proxy próprio, `monitor-proxy` mostra `certificate obtained successfully` para os dois nomes. Um erro de ACME quer dizer que o DNS ainda não aponta para o servidor, ou que a porta 80/443 está fechada.

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
| Atualizar a estrutura do arquivo (raro; quando um PR mexer em `servidor/docker-compose.yml`) | Compare com o modelo novo do repositório e leve só as mudanças. **Não sobrescreva**: o seu arquivo tem os valores preenchidos |
| Backup dos dados (histórico, token do ML) | `docker run --rm -v monitor-nfe_monitor_data:/dados -v "$PWD":/backup alpine tar czf /backup/dados-$(date +%F).tgz -C /dados .` |
| Mudar uma variável ou o `config.yml` (ex.: série nova) | Edite o `docker-compose.yml` e rode `docker compose up -d` (recria só o que mudou) |
| Pausar o monitor (manutenção do gateway) | `MODO_AGENDA: off` no `docker-compose.yml` e `docker compose up -d`. O painel continua mostrando o estado |
| Manter os avisos, mas sem contingência | `CONTINGENCIA: "off"` no `docker-compose.yml` e `docker compose up -d` |
| **Criar a conta de uma pessoa** | `docker compose exec api node dist/senha.js <usuario> <leitura\|operacao>` (pede a senha, mínimo de 12 caracteres, sem eco). Acrescente a linha impressa em `PAINEL_USUARIOS` no `docker-compose.yml` (separe as contas por vírgula) e rode `docker compose up -d` |
| Trocar a senha de alguém | Gere de novo com o mesmo usuário e substitua a linha. **As sessões abertas dessa pessoa caem na hora** |
| Tirar o acesso de alguém | Apague a linha da pessoa em `PAINEL_USUARIOS` e rode `docker compose up -d`. A sessão dela para de valer |
| Derrubar todas as sessões (suspeita de vazamento) | Gere um novo `SESSAO_SEGREDO` e rode `docker compose up -d`. Todo mundo entra de novo |
| Trocar o token da API (scripts) | Gere um novo `MONITOR_HTTP_TOKEN`, troque no `docker-compose.yml` e nos scripts, e rode `docker compose up -d` |
| Ver quem entrou e quem operou | `docker compose logs api \| grep -E "Login\|Executar agora"` |

Os logs giram sozinhos: são 10 MB × 5 arquivos por serviço.

## 4. Migração da sua máquina para o servidor AWS

Hoje a produção roda na sua máquina. É nela que estão o token do ML em uso, a trava da contingência e o histórico. A ordem existe por causa do token do ML de uso único e da contingência.

1. Confirme no servidor: **IP fixo**, Security Group (80/443), os dois registros DNS A apontando para ele, e **o IP liberado no SFTP do cliente e no bastion do Nerus**. Se der, teste do servidor: `ssh -i ~/chaves/bastion.pem ec2-user@<bastion> exit`.
2. Monte o `~/monitor-nfe/docker-compose.yml` do servidor (seção 1). Use os valores do `.env` e do `monitoramento/config.yml` da sua máquina, e troque `PAINEL_HOST`/`API_HOST` pelos DNS reais. As contas (`PAINEL_USUARIOS`) e o `SESSAO_SEGREDO` podem ser copiados como estão: as senhas continuam as mesmas.
3. **Na sua máquina, pare tudo:** `cd ~/Projetos/monitor-nfe-sftp && docker compose down`. Daqui em diante, nada renova o token nem agenda ciclos ali.
4. Leve a chave e os dados (obrigatório: `monitoramento/data/ml-tokens.json` tem o token do ML **atual**, com prioridade sobre o que está no arquivo):
   ```bash
   # da sua máquina
   scp secrets/bastion.pem <servidor>:~/chaves/bastion.pem
   scp -r monitoramento/data <servidor>:~/monitor-nfe-dados
   # no servidor: põe os dados no volume do monitor e confere
   ssh <servidor>
   chmod 600 ~/chaves/bastion.pem
   cd ~/monitor-nfe && docker compose create                # cria o volume monitor-nfe_monitor_data
   docker run --rm -v monitor-nfe_monitor_data:/dados -v ~/monitor-nfe-dados:/origem alpine cp -a /origem/. /dados/
   docker run --rm -v monitor-nfe_monitor_data:/dados alpine ls /dados   # deve listar ml-tokens.json, historico, …
   rm -rf ~/monitor-nfe-dados
   ```
5. Suba e verifique (seção 2).
6. **Não religue a sua máquina** com `MODO_AGENDA=ativo`. Para desenvolver nela, tire `MODO_AGENDA` e `CONTINGENCIA` do `.env` local (volta a ser sombra/off) e use outro `ML_REFRESH_TOKEN`, ou deixe vazio.

## 5. Rollback

- **Para a versão anterior:** cada merge publica também uma tag `sha-<commit>`. No `docker-compose.yml` do servidor, troque `:latest` das três imagens por `:sha-<commit anterior>` (veja as versões em GitHub → Packages) e rode `docker compose pull && docker compose up -d`. Para voltar a acompanhar a `main`, ponha `:latest` de novo.
- **De volta para a sua máquina:**
  1. `docker compose down` no servidor.
  2. Copie os dados do volume de volta para a `monitoramento/data/` da sua máquina, porque o token do ML girou no servidor: use o comando de backup da seção 3 e descompacte na pasta.
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
3. Coloque o `access_token` e o `refresh_token` da resposta em `ML_ACCESS_TOKEN` e `ML_REFRESH_TOKEN` no `docker-compose.yml`.
4. **Apague o `ml-tokens.json` do volume:** `docker compose exec api rm /app/data/ml-tokens.json`. Ele tem prioridade sobre o que está no arquivo. Se ficar, o monitor continua tentando o token morto.
5. Rode `docker compose up -d --force-recreate api`. No log, deve aparecer `token ML renovado` na próxima checagem.

## Referência das variáveis

No servidor elas ficam no `environment` do `servidor/docker-compose.yml`; no desenvolvimento, no `.env`. Os comentários de cada uma estão no `.env.example`. "No servidor" significa obrigatória no servidor AWS e ausente na sua máquina.

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
