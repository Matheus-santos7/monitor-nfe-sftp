# Fluxo de monitoramento e diagnóstico

Séries, seller e tenant vêm do `.env` / `config.yml`.

> Workflow `workflows/monitor-sftp.json`: os passos 1–6 abaixo rodam dentro do monitor via `POST /ciclo` e `POST /ciclo/conferir`; o n8n só agenda, faz o Wait (`espera` = 10 min / 2 min) e envia `mensagens[]`. Sem teto do ML e sem furo visível, o aviso é **"cobertura parcial"**, nunca "100% OK". Ver [ADR-004](decisions/0004-regra-no-monitor-n8n-so-orquestra.md).

## 1. Checagem (monitor)

`POST /ciclo` — o **n8n** é o relógio (Schedule Trigger, seg–sex de hora em hora das 8h às 18h). O monitor não agenda sozinho.

1. Lista XMLs nos diretórios SFTP (`config.yml`).
2. Baixa o ZIP do ML **só do dia atual** (`ML_TETO_DIAS=1`):

   `GET /users/{id}/invoices/sites/MLB/batch_request/period/stream?start=&end=&sale=authorized&file_types=xml&simple_folder=true`

3. Por série, o **teto** é o maior número no ZIP. A sequência completa exige todos os números de `nota_inicial` até o teto **no FTP**, inclusive a última emitida pelo ML.
4. Sem credencial ML (`ML_REFRESH_TOKEN` + client id/secret), o teto some e a sequência usa só o max do FTP (furos no fim ficam invisíveis).
5. Antes de baixar o ZIP, o monitor renova o `ML_ACCESS_TOKEN` via `POST /oauth/token` (`grant_type=refresh_token`) e grava o par novo — o refresh é de uso único.

Documentação ML: [Gestão e Consulta de Notas Fiscais](https://developers.mercadolivre.com.br/pt_br/obtendo-nota-fiscal).

## 2. Se a integração está 100% OK

O `/ciclo` devolve `status: ok` e o resumo em `mensagens[]`; o n8n envia Google Chat / e-mail / WhatsApp. Com avisos (ex.: sem teto ML) e sem furo visível, o status é `degradado` e o texto é "cobertura parcial".

## 3. Se há NF ausente

Para **cada** `numero/serie` ausente no mesmo ciclo (sem teto de 5):

1. Localiza `invoice_id` + chave no mesmo ZIP do ML.
2. Consulta o MySQL via SSH (um túnel para o ciclo inteiro):

| Passo | SQL (ideia) | Significado |
|---|---|---|
| Notificação | `nerus_gateway.notification_control` · `type_notification = 'invoices'` · resource contém `/users/{seller}/invoices/{invoiceId}` | O ML avisou o gateway |
| Destinos | `nerus_gateway.notification_control_target` pelo `notification_control_id` | `SUCCESS` / `ERROR` |
| Nota | `nerus_o2.invoice` · `tenant_id` + `external_id` | Integrada? `channel_status`, `status` |
| Envio FTP | `nerus_o2.fiscal_document_deliveries` · `document_id` = chave 44 | `SENT` / `PENDING` / `PROCESSING` / `RETRY_SCHEDULED` / `FAILED` / `SKIPPED` / `CANCELED` |

## 4. Decisão

| Situação | Ação |
|---|---|
| Sem linha em `notification_control` | Avisa o admin **e** contingência (renotifica) |
| Notificou, nota não está em `invoice` | Só admin (sem contingência) |
| Nota integrada, entrega `SENT` | Recheca o SFTP (rotina de reenvio já rodou) |
| Nota integrada, `PENDING` / `PROCESSING` / `RETRY_SCHEDULED` | Espera **10 min**, consulta de novo; se não virar `SENT`, admin |
| Nota integrada, `FAILED` / `SKIPPED` / `CANCELED` | Admin (sem espera) |
| Sem linha de entrega | Admin |

## 5. Contingência

Só quando o ML **não** notificou o gateway.

1. `POST` signin Nerus (`NERUS_AUTH_URL`) com `NERUS_USERNAME` / `NERUS_PASSWORD`.
2. `POST {NERUS_NOTIFICATION_URL}?clientId={tenant}` com `Authorization: Bearer {token}` (um único Bearer) e body no formato do feed `invoices`:

```json
{
  "_id": "<uuid novo>",
  "topic": "invoices",
  "resource": "/users/<seller_id>/invoices/<invoiceId>",
  "user_id": 0,
  "application_id": 0,
  "sent": "<ISO agora>",
  "attempts": 1,
  "received": "<ISO agora>",
  "actions": []
}
```

3. O monitor não renotifica a mesma invoice duas vezes em 30 min (trava contra execução repetida).
4. O `/ciclo` diagnostica **cada** NF ausente (uma por vez). Só então o n8n espera **2 minutos** (contingência) ou **10 minutos** (envio FTP pendente) **uma vez para o lote**.
5. `POST /ciclo/conferir` confere o SFTP de **todas** as notas do lote. Se ainda faltar alguma, o n8n espera mais 2 minutos e confere de novo.
6. Avisa o resultado de cada NF e um resumo do lote (`3/5 no FTP`, etc.).

## 6. Relatório

Chat, e-mail e WhatsApp recebem um texto nesta ordem:

1. **Resultado** — resolvido, em andamento ou precisa de atenção (depois de reconsultar o FTP).
2. **O que aconteceu** — causa em linguagem comum (sem nome de tabela).
3. **O que o monitor fez** — contingência, espera, reconsulta.
4. **Onde parou** — só se ainda não resolveu, e só até o primeiro erro (os passos seguintes não rodaram).
5. **O que fazer** — nada / aguardar / acionar o time técnico.
6. **Rastro técnico** — consultas na ordem: tabela, filtro, linhas, ids e status; o que não rodou fica explícito; reconsulta de entrega e SFTP no final.

O texto final é montado pelo monitor (`relatorio.ts`) depois da reconferência do FTP; o n8n só envia.

## FAKE_NOTA

`FAKE_NOTA=1000/1` no `.env` (n8n **e** monitor) injeta essa NF como ausente depois da análise real. Serve para exercitar diagnóstico sem furo de verdade. Desligar com vazio / `0` / `false` / `off` e recriar os containers.
