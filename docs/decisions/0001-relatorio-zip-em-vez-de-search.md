# ADR-001: Relatório ZIP em vez de `/invoices/search`

## Status

Accepted

## Date

2026-08-24

## Context

Precisávamos do `invoice_id` do Mercado Livre a partir do número/série da NF-e (chave de 44 dígitos) para diagnosticar o gateway Nerus.

A documentação pública de consulta individual exige `invoice_id`, `order_id` ou `shipment_id`. Não há “listar notas por número”. Um `GET /users/{id}/invoices/search` existe na prática da plataforma, mas nesta aplicação retorna **403 PolicyAgent** (`PA_UNAUTHORIZED_RESULT_FROM_POLICIES`) mesmo com token válido (`GET /users/me` 200).

Varredura de pedidos (`GET /invoices/orders/{order_id}`) é lenta, muitos 404, e o número da NF não bate 1:1 com pedidos recentes.

## Decision

Usar o download em lote oficial:

`GET /users/{user_id}/invoices/sites/MLB/batch_request/period/stream`

Arquivos no ZIP (`simple_folder=true`): `{invoice_id}_{chave44}-procNFe.xml`. Série = dígitos 23–25 da chave; número = 26–34.

Cache do ZIP ~5 min. Retry em 429.

Fonte: [Gestão e Consulta de Notas Fiscais](https://developers.mercadolivre.com.br/pt_br/obtendo-nota-fiscal) (atualizado 18/08/2026).

## Alternatives considered

### `/invoices/search`

- Prós: JSON paginado, sem ZIP.
- Contras: 403 nesta app; fora da doc oficial de consulta.
- Rejeitado.

### GET por `order_id` em lote

- Prós: endpoint documentado.
- Contras: não descobre o teto da série; muitos misses.
- Rejeitado como caminho principal.

## Consequences

- Dependência de ZIP (payload maior, timeout maior no n8n).
- Nome do arquivo é o contrato; CT-e e outros padrões são ignorados pelo parser.
- O mesmo ZIP alimenta teto da sequência e lookup de `invoice_id`.
