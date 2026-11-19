# Camada de visualização: painel e histórico

O painel mostra, em tempo real, se a integração está em dia. Ele **não envia avisos**: quem avisa é o ciclo agendado. É o serviço `painel` (nginx com `painel/index.html`), atrás do proxy HTTPS. Os dados vêm de `GET /status` e `GET /historico` da `api`, repassados pelo nginx no mesmo endereço ([api.md](api.md)).

## Como abrir

| Onde | URL |
|---|---|
| Servidor | `https://PAINEL_HOST` |
| Local | `http://localhost:8080` ou `https://painel.localhost` |

A página abre na tela de **login** (usuário e senha). Uma conta por pessoa ([deploy.md](deploy.md#3-operação-do-dia-a-dia) explica como criar):

| Papel da conta | Para quem | Vê |
|---|---|---|
| `leitura` | Time e **cliente** | Tudo, menos o botão **Executar agora** (a API também recusa: 403) |
| `operacao` | Só o time técnico | Tudo, com o botão |

**Nada secreto vai na URL.** O login cria uma sessão de 12 h num cookie `HttpOnly` (o JS da página não lê), `Secure` (só HTTPS) e `SameSite=Strict` (não vai em requisições de outros sites). O botão **Sair** apaga o cookie. As ações que mudam algo exigem, além do cookie, o header `X-Painel` e a origem do painel, para que outro site não consiga disparar o **Executar agora** no navegador de quem está logado. Um link antigo com `?token=` é ignorado e a página pede o login. A página não é indexada (`noindex`), não repassa a URL (`no-referrer`) e não pode ser embutida em outro site (`frame-ancestors 'none'`).

Errar a senha 5 vezes em 15 min, do mesmo IP, bloqueia aquele usuário por 15 min naquele IP. Uma pessoa errando de outro lugar não trava o cliente.

## Atualização

- O **monitor** roda uma checagem silenciosa a cada `PAINEL_INTERVALO_MIN` (padrão 5; `0` desliga). Ela não diagnostica, não dispara contingência e não avisa.
- A **página** lê o estado a cada 1 min e atualiza o "há X min" a cada 30 s.
- O título da aba mostra ✅ (ok), ⏳ (aguardando) ou ⚠️ (qualquer outra coisa). Dá para acompanhar com a aba em segundo plano.

## Como ler cada parte

### Ciclo de monitoramento

Mostra o modo da agenda (desligada, sombra ou ativa), o próximo horário, a etapa em andamento ("confere às 10:42") e o último ciclo: origem, status, quantos avisos e se algum ficou **sem entrega** em nenhum canal.

O botão **Executar agora** roda o ciclo completo na hora. Ele pede confirmação, e em `ativo` pode disparar contingência real. Fica desligado com `MODO_AGENDA=off` ou com um ciclo em andamento.

### Faixa de status

| Cor / status | Texto | Significa | O que fazer |
|---|---|---|---|
| Verde `ok` | "Tudo integrado — última NF do ML está no FTP e não há furos" | Tudo certo **e** a checagem está completa | Nada |
| Laranja `alerta` | "N nota(s) ausente(s) no FTP" | Há furo | Veja a tabela de ausentes. O ciclo diagnostica na próxima hora cheia, ou use **Executar agora** |
| Vermelho `erro` | "Checagem falhou: …" | O SFTP ou a checagem quebrou | Veja o log do monitor |
| Vermelho `erro` | "Checagem incompleta — veja os avisos" | Cobertura degradada (ex.: sem teto do ML) | Leia **Avisos**. Pode haver furo que o monitor não está vendo |
| Cinza `aguardando` | "Aguardando a primeira checagem…" | O monitor acabou de subir | Espere um ciclo |
| Vermelho | "Painel sem conexão com o monitor" | A página não alcança o `/status` (monitor fora) | Confira o container e o token |

### Avisos

Motivos de cobertura parcial ou problema de configuração:

- "Teto ML indisponível: …": a API do ML falhou ou devolveu 429.
- "Credenciais ML ausentes": o monitor está usando só o FTP como referência.
- "Série X: nenhum XML no FTP".
- "Histórico não gravado: …": problema de disco.

### Notas ausentes no FTP

NF/série, **ausente desde** (a primeira checagem que viu o furo) e **há quanto tempo**. A linha fica **vermelha a partir de 15 min**: até aí pode ser só a latência normal de envio; depois disso é atraso real.

### Saúde do dia

Um seletor permite escolher o dia; o padrão é hoje.

| KPI | Cálculo |
|---|---|
| Saúde | `Crítico` se algum furo está aberto há **60 min ou mais**. `Atenção` se houve furo, falha ou checagem não-ok no dia. `Saudável` se não houve nada. `Sem dados` se não houve checagem |
| Checagens OK | % de checagens `ok` no dia (ok/total) |
| Furos no dia · Resolvidos · Em aberto | Contagem de eventos. "Em aberto" mostra também o mais antigo |
| Tempo médio / pior até o FTP | Quanto os furos resolvidos demoraram para aparecer no FTP |
| Falhas de checagem | Quantas vezes a checagem quebrou |

Em um dia que já passou, a idade dos furos é medida na última checagem daquele dia, não "agora".

### Histórico de avisos do dia

Um evento só é gravado quando o estado **muda**. Uma checagem igual à anterior não gera linha.

| Evento | Quando |
|---|---|
| ⚠️ Furo | Uma NF passou a faltar |
| ✅ Resolvido | A NF apareceu no FTP. Mostra a duração |
| ❌ Falha | A checagem quebrou (só a primeira de uma sequência igual) |
| 🔄 Voltou | A checagem voltou a funcionar |
| ℹ️ Aviso | Um aviso novo apareceu |

### Séries

Por série: XMLs no FTP, faixa no FTP (min–max), teto do ML, se a última do ML está no FTP, e quantas faltam.

## Onde os dados ficam

- **Estado atual** (`/status`): fica em memória e zera num restart. O "ausente desde" é retomado do histórico do dia na subida.
- **Histórico:** `monitoramento/data/historico/AAAAMMDD.json`, um arquivo por dia no fuso America/Sao_Paulo. A gravação é atômica (arquivo temporário + rename). Os furos abertos passam para o arquivo do dia seguinte à meia-noite.
- **Arquivo corrompido:** é movido para `AAAAMMDD.json.corrompido-<ms>`, e o dia recomeça. A checagem não para.
- **Retenção:** não há limpeza automática. Cada arquivo tem poucos KB; apague os antigos à mão se precisar.
