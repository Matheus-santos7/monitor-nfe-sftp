# Monitor SFTP NF-e

Serviço Node que o n8n chama (o n8n é o relógio). A documentação do **projeto** (stack, fluxo, API, ADRs) está na [raiz](../README.md) e em [docs/](../docs/).

## Configuração

```bash
cp config.example.yml config.yml
```

`config.yml` não vai para o git.

## Testes

```bash
npm test
```

## HTTP

O container escuta `8080`. No host: `http://127.0.0.1:8081`. Contrato: [docs/api.md](../docs/api.md).
