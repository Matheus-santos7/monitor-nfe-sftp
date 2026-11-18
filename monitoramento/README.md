# monitor-sftp

O serviço Node 22 + TypeScript que contém toda a regra do monitor NF-e. O n8n o chama via HTTP.

- **Onde fica cada coisa e como testar:** [docs/monitor.md](../docs/monitor.md)
- **Contrato HTTP:** [docs/api.md](../docs/api.md)
- **Visão geral e como rodar (via Docker Compose, na raiz):** [README da raiz](../README.md)

```bash
cp config.example.yml config.yml   # fora do Git
npm ci
npm run check                      # typecheck + testes (o mesmo que o CI)
```

O container escuta na porta `8080`. No host, o endereço é `http://127.0.0.1:8081`.
