# ADR-002: Teto da sequência vem do Mercado Livre

## Status

Accepted

## Date

2026-08-24

## Context

O monitor só olhava o FTP: `max` da série = último XML no SFTP. Se as últimas NFs do ML nunca chegassem, a sequência parecia completa.

Não existe `GET /invoices/last`. A última autorizada por série sai do ZIP `sale=authorized` (ADR-001).

## Decision

1. Baixar o ZIP **só do dia atual** (`ML_TETO_DIAS=1`). Série sem emissão hoje fica sem teto ML (cai no max do FTP).
2. Por série monitorada, teto = maior `numero` no relatório.
3. Furos = números ausentes no FTP de `nota_inicial` até o teto (não até o max do FTP).
4. Números no FTP **depois** do teto (outro canal/ERP) não geram alerta.
5. Se o ZIP falhar ou não houver token, cair no comportamento antigo (só FTP) e logar aviso.

A confirmação pontual `GET /users/{id}/invoices/{invoice_id}` (`invoice_number`, `invoice_series`) existe, mas o teto do job usa só o ZIP para não N+1.

## Alternatives considered

### Só FTP

- Prós: simples, sem ML.
- Contras: cego para o furo no fim.
- Rejeitado como único critério.

### ZIP de 7 dias

- Prós: teto correto mesmo sem emissão hoje.
- Contras: ZIP maior, checagem mais lenta.
- Substituído: o relógio roda várias vezes ao dia; basta o ZIP de hoje.

## Consequences

- Cada checagem baixa o ZIP de **hoje** (mais rápido; 429 com backoff).
- Sem emissão no dia, `tetoMl` fica `null` e a sequência usa só o FTP.
- `GET /ml/teto` permite conferir o teto sem rodar o SFTP.
