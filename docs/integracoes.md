# Camada de integrações: SFTP, Mercado Livre e Nerus

O monitor conversa com três sistemas de fora. Todos são de produção: não existe ambiente de teste de nenhum deles.

| Sistema | Para quê | Módulos | Se cair |
|---|---|---|---|
| SFTP do cliente | Saber quais XMLs chegaram | `sftp.ts`, `chave.ts`, `gaps.ts` | A checagem falha → Error Handler do n8n / painel "Checagem falhou" |
| Mercado Livre | Teto da sequência e `invoice_id` de cada NF | `ml-auth.ts`, `ml-invoices.ts` | "Cobertura parcial" (sem teto) ou "Não foi possível consultar o Mercado Livre" (na NF) |
| Nerus (gateway fiscal) | Em que etapa a nota parou; contingência | `nerus-db.ts`, `diagnostico.ts`, `nerus-contigencia.ts` | A NF sai "Não foi possível consultar o Nerus", sem contingência |

## SFTP

- **Configuração:** `sftp` no `config.yml` (`host`, `porta`, `usuario`, `senha`, `diretorios`, `ip_origem`). A autenticação é por senha, com timeout de conexão de 20 s.
- **`ip_origem`:** se preenchido, a conexão sai por esse IP local. Serve para a VPN, quando o SFTP só aceita um IP.
- **Diretórios:** todos os de `diretorios` são listados (ex.: a pasta de entrada e `Transferidos`). Um diretório que falha é pulado, com aviso no log, e os outros seguem.
- **O que conta como presente:** só o **nome** do arquivo é lido, nunca o conteúdo.
  - **NF-e:** `…NFe<chave 44 dígitos>.xml`, ou um nome que começa com a chave. Série e número saem da chave (modelo 55).
  - **Inutilização:** `…Inut-ID<dígitos>.xml`. Toda a faixa de números conta como presente.
  - Outros arquivos são ignorados.

## Mercado Livre

### OAuth e o token de uso único

- O access token dura cerca de 6 h. O monitor renova com o refresh token antes de expirar (`ml-auth.ts`).
- **O refresh token é de uso único:** cada renovação devolve um par novo, e o antigo morre. O monitor grava o par novo em dois lugares:
  1. `monitoramento/data/ml-tokens.json`. **Esse arquivo tem prioridade** sobre o `.env` na subida.
  2. O próprio `.env`, montado no container como `/app/.env.host`.
- Consequências práticas:
  - **Nunca rode localmente com o refresh token da produção.** A primeira renovação local mata o da VPS.
  - Para trocar o token à mão, atualize o `.env` **e** apague o `ml-tokens.json`, senão o arquivo antigo vence. O procedimento completo está em [deploy.md](deploy.md#5-o-token-do-mercado-livre-morreu).
- Variáveis: `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_ACCESS_TOKEN`, `ML_REFRESH_TOKEN`, `ML_USER_ID` (o seller).

### Relatório ZIP de NF-e

- **Busca do teto:** `GET /users/{seller}/invoices/sites/MLB/batch_request/period/stream?start=&end=&sale=authorized&file_types=xml&simple_folder=true…`. A janela é o dia atual (`ML_TETO_DIAS=1`).
- **Busca no mês:** `…/batch_request/period/{AAAAMM}`, usado quando a NF não está nos últimos 7 dias.
- **O monitor lê só os nomes dentro do ZIP:** `{invoice_id}_{chave}-procNFe.xml`. Dali saem o `invoice_id`, a série e o número.
- **Teto:** o maior número por série entre os nomes do ZIP.
- **Localizar uma NF:** tenta o dia, depois os últimos 7 dias, depois o mês.
- **Cache:** cada ZIP baixado fica em memória por `ML_TETO_CACHE_MIN` (padrão 5 min). Se aparecer 429 (limite de taxa), suba esse valor.
- **Por que não `/invoices/search`:** essa rota retorna 403 para esta aplicação ([ADR-001](decisions/0001-relatorio-zip-em-vez-de-search.md)).

<a id="nerus"></a>
## Nerus (gateway fiscal)

### MySQL via SSH

- **Caminho:** SSH até o bastion (`NERUS_SSH_HOST`, `NERUS_SSH_USER`, chave em `/run/secrets/bastion.pem`) e, de lá, um túnel até o MySQL (`NERUS_DB_HOST`, `NERUS_DB_PORT`), com o usuário `NERUS_DB_USER`.
- **A chave SSH:** fica em `secrets/bastion.pem` no host, fora do Git, com `chmod 600`. Se o arquivo estiver vazio, o erro é `Cannot parse privateKey`.
- **Uma sessão por ciclo:** um único túnel e uma única conexão servem todas as NFs do `/ciclo` (`comSessaoNerus`). Se a abertura falhar, todas as NFs do ciclo recebem o mesmo erro na hora, sem esperar o timeout de cada uma.
- **Timeouts:** 20 s para conectar o SSH e o MySQL, 30 s por query.
- **Só leitura:** as queries são parametrizadas e não escrevem nada.

| Ordem | Tabela | Filtro | Responde |
|---|---|---|---|
| 1 | `nerus_gateway.notification_control` | `type_notification='invoices'`, `user_id` = seller, `notification_sended` contém `/users/{seller}/invoices/{invoiceId}` | O ML avisou o gateway? |
| 2 | `nerus_gateway.notification_control_target` | `notification_control_id` | O aviso foi processado (`SUCCESS`/`ERROR`)? |
| 3 | `nerus_o2.invoice` | `tenant_id` (`NERUS_TENANT_ID`), `external_id` = invoiceId | A nota entrou no Nerus? `status`, `channel_status` |
| 4 | `nerus_o2.fiscal_document_deliveries` | `tenant_id`, `document_id` = chave 44 | O envio ao FTP: `SENT`, `PENDING`, `FAILED`… |

Cada consulta vira uma linha do "Rastro técnico" do relatório. Uma consulta com erro aparece como `ERRO:` e impede a contingência. O que o resultado significa está em [regra-de-negocio.md](regra-de-negocio.md#3-diagnóstico-de-cada-nf-ausente).

### API de contingência

1. `POST NERUS_AUTH_URL` com `NERUS_USERNAME` e `NERUS_PASSWORD` devolve o token.
2. `POST {NERUS_NOTIFICATION_URL}?clientId={NERUS_TENANT_ID}` com `Authorization: Bearer`. O corpo imita um aviso do ML: `topic: "invoices"`, `resource: /users/{seller}/invoices/{invoiceId}`, `user_id`, `application_id` (= `ML_CLIENT_ID`) e um `_id` novo.

Só roda com `CONTINGENCIA=on`, e no máximo uma vez a cada 30 min por invoice. O timeout é de 30 s.
