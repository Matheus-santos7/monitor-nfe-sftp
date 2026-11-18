# Deploy, troca de workflow e recuperação

Não existe staging. Cada passo abaixo age no cliente real. Siga a ordem e não pule a verificação no final de cada etapa.

## Antes de começar

Você precisa de:

| Acesso | Para quê |
|---|---|
| SSH na VPS | rebuild do monitor e leitura dos logs |
| Editor do n8n de produção | importar, ativar e desativar workflows |
| `.env` e `monitoramento/config.yml` da VPS | ficam só no servidor, nunca no Git |
| App do Mercado Livre (client id e secret) | só para recuperar o token (ver o fim desta página) |

Se faltar algum desses acessos, pare e peça ao responsável pelo projeto. Não tente contornar.

## Nunca faça

- **Nunca use o `ML_REFRESH_TOKEN` da produção na sua máquina.** O refresh é de uso único: a primeira renovação local invalida o da VPS, e a produção fica sem o teto do ML.
- **Nunca deixe dois workflows de monitoramento ativos para o mesmo cliente.** A contingência rodaria em dobro.
- **Nunca suba o monitor novo enquanto o workflow antigo estiver ativo.** O workflow antigo chama rotas que já não existem (`/executar`, `/diagnostico`).
- **Nunca coloque `CONTINGENCIA=on` fora da VPS.** O padrão é `off`, e só o `docker-compose.prod.yml` liga.
- **Nunca rode `/ciclo` em produção para "testar".** Use o teste de fumaça abaixo, com `CONTINGENCIA=off`.

## 1. Validar a mudança na sua máquina

```bash
cd monitoramento && npm run check     # typecheck + testes (o CI roda o mesmo)
cd .. && docker compose up -d --build monitor-sftp
docker compose logs --tail 20 monitor-sftp   # deve aparecer "Contingência desligada"
```

Abra `http://localhost:8081/painel?token=<MONITOR_HTTP_TOKEN do seu .env>`.

Para ver um furo sem esperar um de verdade, faça assim:

1. No `.env`, coloque `FAKE_NOTA=99999/2`, usando uma série do seu `config.yml` e um número que não exista.
2. Rode `docker compose up -d --force-recreate monitor-sftp`.
3. Confira que o painel mostra a NF 99999/2 ausente.
4. Volte `FAKE_NOTA=` para vazio e recrie o container de novo.

## 2. Deploy do monitor na VPS

```bash
ssh <vps>
cd <pasta do projeto>
git fetch && git checkout <commit ou tag aprovado>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build monitor-sftp
docker compose logs --tail 20 monitor-sftp
```

Verifique:

- O log mostra `monitor-sftp pronto` e `Contingência LIGADA`. Se aparecer "desligada", o `.env` da VPS tem `CONTINGENCIA` com outro valor: corrija o arquivo antes de seguir.
- `curl -s http://127.0.0.1:8081/health` responde `{"ok":true,...}`.
- `curl -s -H "Authorization: Bearer $MONITOR_HTTP_TOKEN" http://127.0.0.1:8081/status` responde 200. Um 401 com a mensagem "defina MONITOR_HTTP_TOKEN" quer dizer que falta o token no `.env`.
- Painel: abra um túnel com `ssh -L 8081:127.0.0.1:8081 <vps>` e acesse `http://localhost:8081/painel?token=...` no seu navegador.

Mudou só o `config.yml`, por exemplo uma série nova? Rode `docker compose restart monitor-sftp`, sem rebuild. Mudou o `.env`? Rode `up -d --force-recreate monitor-sftp n8n`.

## 3. Trocar o workflow no n8n (primeira vez ou JSON alterado)

A ordem importa.

1. Importe o JSON. Ele entra **inativo**:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps n8n import:workflow --input=/files/workflows/monitor-sftp.json
   ```
2. No editor do n8n, **desative** o workflow antigo de monitoramento. Confira na lista que ele aparece como inativo.
3. Faça o deploy do monitor (etapa 2), se ainda não fez.
4. No workflow **1. Monitor SFTP NF-e (ciclo)**:
   - Em Settings → Error workflow, escolha **0. Error Handler — Monitor NF-e**.
   - Para o primeiro teste, coloque `CONTINGENCIA=off` no `.env` da VPS e recrie o monitor.
   - Clique em **Executar agora** e confira as mensagens no Chat e no e-mail.
5. Volte `CONTINGENCIA` para `on` (ou remova a linha), recrie o monitor e **ative** o workflow.
6. Na próxima hora cheia, confira no n8n que a execução agendada terminou verde e que o painel atualizou.

## 4. Rollback

O monitor e o workflow voltam juntos. Um não funciona com a versão antiga do outro.

1. No n8n, desative o workflow **1. Monitor SFTP NF-e (ciclo)**.
2. Na VPS, rode `git checkout <commit anterior>` e repita o comando de deploy da etapa 2.
3. Se voltar para antes desta branch (`b8fe41c` ou anterior), reative o workflow antigo. Ele ainda existe no n8n; se não existir, importe-o a partir desse commit.

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
