# Fluxo de monitoramento e diagnóstico

Séries, seller e tenant vêm do `.env` / `config.yml`.

## 1. Checagem (monitor)

`POST /executar` — o **n8n** é o relógio (Schedule Trigger, seg–sex 8h/12h/15h/17h). O monitor não agenda sozinho.

1. Lista XMLs nos diretórios SFTP (`config.yml`).
2. Baixa o ZIP do ML **só do dia atual** (`ML_TETO_DIAS=1`):

   `GET /users/{id}/invoices/sites/MLB/batch_request/period/stream?start=&end=&sale=authorized&file_types=xml&simple_folder=true`

3. Por série, o **teto** é o maior número no ZIP. A sequência completa exige todos os números de `nota_inicial` até o teto **no FTP**, inclusive a última emitida pelo ML.
4. Sem credencial ML (`ML_REFRESH_TOKEN` + client id/secret), o teto some e a sequência usa só o max do FTP (furos no fim ficam invisíveis).
5. Antes de baixar o ZIP, o monitor renova o `ML_ACCESS_TOKEN` via `POST /oauth/token` (`grant_type=refresh_token`) e grava o par novo — o refresh é de uso único.

Documentação ML: [Gestão e Consulta de Notas Fiscais](https://developers.mercadolivre.com.br/pt_br/obtendo-nota-fiscal).

## 2. Se a integração está 100% OK

n8n envia Google Chat / e-mail / WhatsApp: última NF do ML está no FTP e não há furos.

## 3. Se há NF ausente

Para cada `numero/serie`:

1. `GET /ml/invoice?numero=&serie=` → `invoice_id` + chave (mesmo ZIP).
2. `POST /diagnostico` consulta o MySQL via SSH:

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

3. n8n espera **2 minutos**, reconsulta `/diagnostico/entrega` e o SFTP.
4. A nota costuma aparecer em `invoice` em 1–3 min e segue para o controle de envio FTP.

## 6. Relatório

O n8n consolida os 5 passos do diagnóstico (chave completa, horários da tabela + Brasília) e acrescenta a linha do SFTP. Manda para Chat, e-mail e WhatsApp.

## FAKE_NOTA

`FAKE_NOTA=1000/1` no `.env` (n8n **e** monitor) injeta essa NF como ausente depois da análise real. Serve para exercitar diagnóstico sem furo de verdade. Desligar com vazio / `0` / `false` / `off` e recriar os containers.
