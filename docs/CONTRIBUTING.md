# Como contribuir

Guia para quem vai mudar o código. Visão geral e como rodar: [README](../README.md). Onde fica cada coisa: [monitor.md](monitor.md).

## Ambiente

- Docker com Compose v2: sobe o projeto inteiro (`docker compose up -d --build`).
- Node 22: para rodar os testes e o typecheck fora do container.
- `cp -n .env.example .env` e `cp -n monitoramento/config.example.yml monitoramento/config.yml`.
  - **Não** defina `MODO_AGENDA` nem `CONTINGENCIA`: o padrão local é sombra e contingência desligada.
  - **Nunca** use o `ML_REFRESH_TOKEN` da produção.

```bash
cd monitoramento && npm ci
```

## Scripts

<!-- AUTO-GENERATED: package.json (monitoramento/) — regenere com /ecc:update-docs -->
| Comando (em `monitoramento/`) | Executa | O que faz |
|---|---|---|
| `npm run build` | `tsc` | Compila o TypeScript para `dist/` (é o que a imagem Docker roda) |
| `npm run start` | `node dist/index.js` | Roda o build (`dist/index.js`); usado dentro do container |
| `npm run dev` | `tsx src/index.ts` | Roda direto do código com tsx. Exige as variáveis do `.env` exportadas no shell; prefira o Docker Compose |
| `npm run test` | `tsx --test src/*.test.ts` | Testes (`node:test` via tsx). **Não checa tipos** |
| `npm run typecheck` | `tsc --noEmit` | `tsc --noEmit`: só checa tipos |
| `npm run check` | `npm run typecheck && npm test` | Typecheck + testes. **É o que o CI roda**: rode antes de abrir PR |
<!-- /AUTO-GENERATED -->

## Testes

- Os testes usam `node:test` e ficam ao lado do código (`src/*.test.ts`). Rode com `npm run check`.
- **Nenhum teste acessa a rede.** Dependências externas entram por injeção: `DepsCiclo`, `DepsOrquestrador`, os `deps` de `diagnosticarNota` e `canaisDoAmbiente`. Nos testes, todas são falsas.
- Testes que gravam em disco apontam para uma pasta temporária (`HISTORICO_DIR`, `CONTINGENCIAS_PATH`). Nunca para `data/`.
- **Mudou uma regra ou um texto de aviso? Escreva primeiro o teste que falha**, e depois mude o código.
- O caminho da contingência real tem teste em `diagnostico.test.ts`. Se mexer nele, confira que um teste falha quando a trava ou o `CONTINGENCIA` não são respeitados.

## Estilo

- TypeScript com `strict: true`. O projeto não tem linter nem formatter configurado: siga o estilo do arquivo que você está editando.
- Os nomes, mensagens e logs são em português. Os passos do log começam com `▶`.
- Funções que só calculam ficam sem I/O (`gaps.ts`, `relatorio.ts`, `decidirAcao`).
- Um atalho com limite conhecido leva o comentário `// shortcut: <limite>, <quando melhorar>`.
- Segredos e dados de cliente só no `.env` e no `config.yml`. Nunca no código, nos testes ou nos docs.

## Checklist do PR

- [ ] `cd monitoramento && npm run check` passa. O CI roda o mesmo, mais a sintaxe do JS do painel, o `docker compose config` e a compilação das 3 imagens. Depois do merge na `main`, o CI **publica** as imagens no GHCR (`latest` e `sha-<commit>`), e o servidor atualiza com `docker compose pull && docker compose up -d`.
- [ ] A mudança de regra ou de texto tem teste.
- [ ] Testei localmente com `docker compose up` (agenda em **sombra**, contingência **off**), e com `FAKE_NOTA` se mexi no fluxo de furo.
- [ ] Atualizei a documentação da camada que mudou ([docs/README.md](README.md)). Variável nova no `.env.example` (com comentário) e no `docker-compose.yml`.
- [ ] Uma decisão de arquitetura tem ADR novo em `docs/decisions/`.
- [ ] Nenhum segredo nem dado de cliente no diff.
- [ ] Se muda o deploy, o [deploy.md](deploy.md) diz o passo a passo.
