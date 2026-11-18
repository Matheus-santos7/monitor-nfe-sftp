# Dev Team — 2026-11-18

**Tema:** a arquitetura, a tecnologia, o processo e a regra de negócio estão escaláveis e fáceis de manter? A tela do painel passa de verdade uma visão de monitoramento?

Formato: quatro papéis (PM, Arquiteto, Dev, QA) responderam em paralelo, a partir de um resumo do projeto (não leram o código). A síntese foi conferida contra o código.

## PM

- **Primeira reação:** o painel responde "está tudo bem?" e "desde quando?", mas não "por que quebrou?" nem "o que eu faço?". O diagnóstico só vai para o chat, então quem olha a tela precisa abrir outra ferramenta para agir.
- **Preocupações:**
  - Sem teto do ML, a tela mostra um falso "ok".
  - A agenda de seg–sex, 8h–18h, deixa as notas da noite para o dia seguinte.
  - A regra está dividida entre o n8n e o TypeScript, e só o TypeScript tem teste.
  - Um container por cliente aguenta de 1 a 3 clientes.
- **Primeira ação:** mostrar em cada nota ausente a etapa em que ela parou e a ação recomendada. Definir a métrica de sucesso: % de furos resolvidos antes de o cliente reclamar.
- **Pergunta:** o segundo cliente já tem data?

## Arquiteto

- **Primeira reação:** a regra do teto do ML está correta. O ponto fraco é a decisão estar dividida entre os nós Code do n8n e o `diagnostico.ts`.
- **Preocupações:**
  - A decisão precisa de uma fonte única. As esperas e os ramos por status devem ir para o monitor, com teste.
  - O modo degradado fica invisível.
  - A listagem do SFTP é completa a cada checagem e o histórico não tem retenção. Com N clientes, isso vira N tokens, N `.env` e N painéis.
- **Primeira ação:** diagnóstico e ação sugerida no painel, mais um banner de "cobertura degradada".
- **Pergunta:** se o refresh token do ML falhar às 3h de uma sexta, quem fica sabendo antes de segunda?

## Developer

- **Primeira reação:** a regra, que é o valor do produto, está espalhada entre nós Code do n8n, scripts de patch e um arquivo de 980 linhas. Não dá para testar de ponta a ponta.
- **Preocupações:**
  - A regra precisa sair do n8n e virar uma função pura em TypeScript.
  - As fontes são frágeis: listagem completa do SFTP, parser de ZIP feito à mão sem ZIP64, e o 429 do ML pode virar falso OK.
  - Falta retenção do histórico e falta mostrar "última checagem bem-sucedida há X min".
- **Primeira ação:** extrair `decidir(zipML, listaFTP, mysql)` como função pura, com testes de tabela.
- **Pergunta:** quando o ML devolve 429 ou o SSH cai, o operador vê verde, vermelho ou "desconhecido"?

## QA

- **Primeira reação:** a contingência automática foi validada só contra os dados reais do cliente. HTTP 200 não prova que a tela é entendida.
- **Preocupações:**
  - Não há homologação nem dry-run da contingência, e o n8n não tem teste.
  - Faltam testes de borda: 429, inutilização, troca de série, virada da meia-noite com furo aberto, restart e `FAKE_NOTA` ligado em produção.
  - A tela não foi validada por ninguém.
- **Primeira ação:** gravar fixtures a partir dos casos reais, testar a contingência em dry-run e abrir o painel em 3 cenários, cronometrando 10 segundos para entender cada um.
- **Pergunta:** quanto custa uma renotificação indevida no cliente?

## Síntese

- 🚫 **Bloqueante:** a regra de negócio está em dois lugares, e a metade no n8n não tem teste (os quatro papéis apontaram). As decisões por status, as esperas e o lote estão em cerca de 670 linhas de JS em nós Code, alteradas por `tmp-patch-*`.
- 🚫 **Bloqueante:** falso verde quando o ML falha (PM, Arquiteto e Dev apontaram). O painel já trata isso: sem teto, o status vira `erro`. **O n8n não trata.** O nó "Integração OK?" olha só `integracaoOk` e ignora `avisos[]`, então o chat recebe "✅ Todas as notas foram integradas" mesmo sem o ML.
- **Consenso:** a tela mostra o quê e desde quando, mas não o porquê nem o que fazer. Como visão de monitoramento, resolve metade.
- **Tensão QA × PM:** dry-run ou aprovação manual da contingência, contra agir antes do cliente. Quem decide é o custo de uma renotificação indevida.
- **Tensão Dev × PM/Arquiteto:** refatorar primeiro ou entregar valor rápido primeiro. Recomendação: diagnóstico no painel primeiro, migração da regra em seguida.
- **Multicliente:** o limite é de 1 a 3 clientes. A data do segundo cliente define a prioridade; até lá, só documentar.

## Decisões em aberto

1. Quanto custa uma renotificação indevida? Isso decide se a contingência continua automática.
2. Quando entra o segundo cliente?
3. Quem recebe o alerta de falha de token ou de ML fora do horário comercial?
