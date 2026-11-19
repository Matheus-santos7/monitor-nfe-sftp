# ADR-007: Login do painel por conta, sem token na URL

## Status

Accepted. Substitui a parte "dois tokens no link" do ADR-006.

## Date

2026-11-19

## Context

O painel abria com `https://PAINEL_HOST/?token=…`. Mesmo tirando o token da barra de endereço e do log, o token ainda ia parar em favoritos, mensagens e prints, e o link era o mesmo para todos que tinham o mesmo nível. O link de operação também libera o "Executar agora", que pode disparar contingência real. Além disso, não havia registro de quem apertou o botão.

Uma revisão com quatro papéis (PM, arquitetura, desenvolvimento e QA) encontrou armadilhas no primeiro plano:

- o `$` dos hashes seria interpolado pelo compose;
- o `Host` é reescrito pelo nginx, então comparar Origin com Host quebraria;
- o IP chega errado atrás de dois proxies;
- o `scryptSync` travaria o processo;
- o `/login` ficaria exposto pelo `API_HOST`.

## Decision

- **Uma conta por pessoa**, em `PAINEL_USUARIOS`, no formato `usuario:papel:salt_hex:hash_hex`, só com hex. As contas são geradas por `node dist/senha.js`, que pede a senha sem eco. O papel é `leitura` (time e cliente) ou `operacao` (time técnico).
- **Senha:** `scrypt` **assíncrono**, com comparação em tempo constante. Para usuário inexistente, o backend calcula um hash falso, para não revelar quais contas existem.
- **Sessão sem estado, num cookie:**
  - assinado com HMAC-SHA256 (`SESSAO_SEGREDO`);
  - com usuário, validade de 12 h e a impressão do hash da senha. Trocar a senha de alguém derruba as sessões dessa pessoa; remover a conta corta o acesso na hora. O papel vem sempre da conta atual;
  - com as flags `HttpOnly`, `Secure`, `SameSite=Strict` e `Path=/`.
- **Revogação:**
  - de uma pessoa: trocar a senha ou apagar a linha;
  - de todas: trocar o `SESSAO_SEGREDO`.

  O "Sair" só apaga o cookie: um cookie copiado antes continua valendo até expirar ou até uma das revogações acima. Aceitamos isso para não precisar de estado no servidor.
- **CSRF:** um `POST` autenticado por cookie (incluindo o próprio `/login`) exige o header `X-Painel: 1` e `Origin` igual a `https://PAINEL_HOST`, que vem **da config**, nunca do `Host`.
- **Limite de tentativas,** checado **antes** do scrypt: 5 erros por usuário+IP e 20 por IP, numa janela de 15 min, em memória. Um restart zera os contadores, e aceitamos isso: o objetivo é só barrar força bruta.
- **IP real:** o Caddy define `X-Forwarded-For` sem confiar no que o cliente mandou. O nginx aceita esse header só da rede interna e sobrescreve o `X-Real-IP`. A `api` usa o `X-Real-IP`.
- **`API_HOST` só com Bearer:** o proxy remove o `Cookie` e responde 404 em `/login`, `/logout` e `/sessao`.
- **Auditoria:** o log registra login (com sucesso e com falha, usuário e IP) e "Executar agora por <usuário>". O último ciclo, no painel, mostra quem o disparou.
- **Endurecimento:** HSTS de 1 dia, sem preload, que pode subir depois que o domínio estiver estável; header `Server` removido; corpo limitado a 16 KB no proxy e a 4 KB no `/login`.

## Alternatives considered

### Basic Auth no Caddy

- **Prós:** nenhum código.
- **Contras:**
  - o popup do navegador;
  - não dá para sair;
  - os papéis e o "quem fez o quê" exigiriam repassar o usuário entre proxies.
- Rejeitado.

### Sessão guardada no servidor (com revogação individual no logout)

- **Prós:** o "Sair" revogaria de verdade.
- **Contras:** estado em disco ou em memória para manter. A revogação por troca de senha cobre o caso real.
- Rejeitado por ora.

### SSO (Google ou OIDC)

- **Prós:** sem senha própria.
- **Contras:** depende de o cliente ter conta no mesmo provedor e traz mais uma peça para operar.
- Rejeitado para uma única pessoa do cliente.

## Consequences

- O `PAINEL_TOKEN` saiu. O `MONITOR_HTTP_TOKEN` virou só o Bearer de scripts e **deve ser trocado** na migração, porque já passou por URL.
- O container da `api` continua rodando como root. Passar para non-root exige alinhar o UID com os bind mounts do host (`data/` e `.env`), testado num Linux. Fica pendente.
- O teste do "Executar agora" com uma conta `operacao` só deve ser feito com `MODO_AGENDA=sombra`, nunca na produção.
