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
| Time técnico | `https://PAINEL_HOST/?token=<MONITOR_HTTP_TOKEN>` | Ver tudo e usar o **Executar agora** |
| Time e cliente | `https://PAINEL_HOST/?token=<PAINEL_TOKEN>` | Ver o painel e o histórico. O botão não aparece, e a API recusa com 403 |
| Integrações e scripts | `https://API_HOST/…`, com `Authorization: Bearer <token>` | Conforme o token |

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
- **Nunca mande o token de operação para o cliente.** Para ele, use só o `PAINEL_TOKEN`.
- **Nunca coloque `MODO_AGENDA=ativo` ou `CONTINGENCIA=on` fora do servidor.**
- **Nunca abra 8080/8081 no Security Group.** Elas não têm HTTPS.

## 1. Instalação no servidor (primeira vez)

```bash
ssh <servidor>
git clone <repositório> monitor-nfe && cd monitor-nfe
cp .env.example .env && chmod 600 .env
cp monitoramento/config.example.yml monitoramento/config.yml
mkdir -p secrets && cp <bastion.pem> secrets/bastion.pem && chmod 600 secrets/bastion.pem
```

No `.env`, além das credenciais (ML, Nerus, SFTP no `config.yml`, canais de aviso):

```
MODO_AGENDA=ativo
CONTINGENCIA=on
PAINEL_HOST=monitor.seusetor.com.br
API_HOST=api-monitor.seusetor.com.br
MONITOR_HTTP_TOKEN=<openssl rand -hex 32>   # operação, só o time técnico
PAINEL_TOKEN=<openssl rand -hex 32>         # leitura, time e cliente (diferente do de cima)
```

Se estiver vindo de outro servidor, faça antes a **seção 4 (migração)**.

## 2. Subir e verificar

```bash
docker compose up -d --build
docker compose ps                 # api, painel e proxy "running" / "healthy"
docker compose logs -f            # Ctrl+C sai sem parar nada
```

O que precisa aparecer nos logs:

- `monitor-api`: `monitor-sftp pronto`, `Contingência LIGADA` e `Agenda do ciclo ATIVA`. Não pode aparecer "nenhum canal de aviso configurado". Se aparecer "desligada" ou "SOMBRA", falta `CONTINGENCIA=on` ou `MODO_AGENDA=ativo` no `.env`.
- `monitor-proxy`: `certificate obtained successfully` para os dois nomes. Se aparecer um erro de ACME, o DNS ainda não aponta para o servidor, ou a porta 80/443 está fechada.

Testes:

```bash
curl -s https://API_HOST/health                                               # {"ok":true,...}
curl -s -H "Authorization: Bearer $PAINEL_TOKEN" https://API_HOST/status | head -c 200
```

Depois abra `https://PAINEL_HOST/?token=<MONITOR_HTTP_TOKEN>`. A seção "Ciclo de monitoramento" deve mostrar "ativa" e o próximo horário. Use o **Executar agora** e confira que os avisos chegam nos canais.

## 3. Operação do dia a dia

| Quero… | Comando |
|---|---|
| Ver os logs ao vivo | `docker compose logs -f`, ou só um serviço: `docker compose logs -f api` |
| Ver a última hora | `docker compose logs --since 1h api` |
| Ver o estado dos containers | `docker compose ps` |
| Atualizar para uma versão nova | `git pull && docker compose up -d --build` |
| Aplicar uma mudança no `.env` | `docker compose up -d --force-recreate api` (ou `proxy`, se mudou `PAINEL_HOST`/`API_HOST`) |
| Aplicar uma mudança no `config.yml` (ex.: série nova) | `docker compose restart api` |
| Pausar o monitor (manutenção do gateway) | `MODO_AGENDA=off` no `.env` e recriar a `api`. O painel continua mostrando o estado |
| Manter os avisos, mas sem contingência | `CONTINGENCIA=off` no `.env` e recriar a `api` |
| Trocar um token (ex.: link vazou) | Gere um novo, troque no `.env`, recrie a `api` e envie os links novos. Os antigos param na hora |

Os logs giram sozinhos: são 10 MB × 5 arquivos por serviço.

## 4. Migração do servidor antigo para a AWS

A ordem existe por causa do token do ML de uso único e da contingência.

1. Confirme que o **IP da AWS está liberado** no SFTP do cliente e no bastion do Nerus. Se tiver acesso, teste antes, do servidor novo: `ssh` no bastion e `sftp` no cliente.
2. **No servidor antigo, pare tudo:** `docker compose down`. Se ele ainda roda o n8n, desative também o workflow no editor antes. Com isso, nada mais renova o token nem agenda.
3. Copie para o servidor novo, por exemplo com `scp -r`: o `.env`, o `monitoramento/config.yml`, a chave do bastion e a **pasta `monitoramento/data/` inteira**. Ela contém o `ml-tokens.json` (o token do ML **atual**, com prioridade sobre o `.env`), o `contingencias.json` e o `historico/`.
4. No `.env` novo, acrescente as variáveis da seção 1 (`MODO_AGENDA`, `CONTINGENCIA`, hosts, `PAINEL_TOKEN`). Tire `COMPOSE_FILE` e as variáveis `N8N_*`, `POSTGRES_*` e de domínio do Traefik, se existirem.
5. Suba e verifique (seção 2).
6. Mantenha o servidor antigo **parado** por uma semana, para rollback. Não o ligue junto com o novo.

## 5. Rollback

- **Para uma versão anterior no mesmo servidor:** `git checkout <commit anterior> && docker compose up -d --build`.
- **De volta ao servidor antigo:**
  1. `docker compose down` na AWS.
  2. Copie de volta a `monitoramento/data/` da AWS para o antigo. O token do ML girou na AWS, e o antigo tem um token morto.
  3. Suba o antigo.

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
