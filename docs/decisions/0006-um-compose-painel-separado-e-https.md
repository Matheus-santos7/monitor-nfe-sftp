# ADR-006: Um compose, frontend separado, HTTPS por Caddy e dois tokens

## Status

Accepted.

## Date

2026-11-18

## Context

O monitor vai rodar num servidor Linux dedicado da AWS do setor. Os requisitos:

- tudo sobe com **um** `docker-compose.yml` e é acompanhado com `docker compose logs`;
- backend e frontend ficam em portas próprias, cada um com **um DNS próprio**;
- o painel e o histórico são enviados ao **time e ao cliente**.

Até aqui, o backend servia o painel numa rota (`/painel`), havia um overlay `docker-compose.prod.yml` e um só token, que também liberava o "Executar agora" (contingência real).

## Decision

- **Três serviços num compose só:**
  - `api`: o backend Node;
  - `painel`: o frontend, em nginx, com `painel/index.html`;
  - `proxy`: Caddy.
- **Portas:** a `api` e o `painel` têm portas próprias, só em `127.0.0.1`, para `curl` e túnel. O `proxy` atende nas portas 80 e 443 e encaminha cada nome (`PAINEL_HOST`, `API_HOST`) para o serviço certo, com certificado automático do Let's Encrypt.
- **Por que um proxy:** o DNS aponta para um IP, não para uma porta. Sem o proxy, o link teria `:8080` e não teria HTTPS, e o token iria aberto pela rede.
- **O nginx do painel repassa à `api` só as rotas que o painel usa.** A página e a API ficam na mesma origem, então não há CORS. Os logs gravam o caminho sem a query string, onde está o token.
- **Dois tokens:**
  - `MONITOR_HTTP_TOKEN`, de operação, só para o time técnico;
  - `PAINEL_TOKEN`, de leitura, para o time e o cliente. Com ele, a API responde 403 nas rotas de operação e o painel esconde o botão.

  O token só vale no header: a API não aceita mais `?token=`.
- **O overlay saiu.** Os padrões do compose continuam seguros (`MODO_AGENDA=sombra`, `CONTINGENCIA=off`), e o `.env` do servidor define `ativo` e `on`. Os logs de subida e o painel mostram o modo.
- **Logs:** rotação `json-file` de 10 MB × 5 por serviço.

## Alternatives considered

### ALB da AWS no lugar do Caddy

- **Prós:** o certificado fica no ACM e o roteamento por nome, no balanceador.
- **Contras:** depende de infraestrutura fora do compose. O usuário escolheu a opção do proxy dentro do compose.
- Rejeitado por ora. Se um ALB vier, basta tirar o `proxy` e apontar o ALB para as portas do `painel` e da `api`.

### Expor 8080/8081 direto, com DNS e porta na URL

- **Prós:** nada a mais para manter.
- **Contras:** sem HTTPS, o token do link circula aberto, e a URL fica com porta.
- Rejeitado.

### Painel continuar servido pelo backend

- **Prós:** um container a menos.
- **Contras:** não atende "frontend em porta própria" e mistura o servir HTML com a API.
- Rejeitado.

## Consequences

- O servidor precisa de Elastic IP, de DNS apontado antes da primeira subida, das portas 80 e 443 abertas e do IP liberado no SFTP do cliente e no bastion do Nerus ([deploy.md](../deploy.md)).
- Trocar um token invalida na hora os links já enviados.
- O volume `caddy_data` guarda os certificados. Apagá-lo força a emissão de novos, e o Let's Encrypt tem limite de taxa.
