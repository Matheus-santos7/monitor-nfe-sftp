import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { AppConfig } from "./types.js";

/** cUF+AAMM+CNPJ+mod 55+série 002+nNF+tpEmis+cNF+cDV = 44 dígitos. */
const chaveSerie2 = (numero: number) =>
  `3526080000000000019155002${String(numero).padStart(9, "0")}1000000010`;

// 6350 fica de fora de propósito: é o furo que o job precisa encontrar.
const ARQUIVOS = [6349, 6351].map((n) => `${chaveSerie2(n)}-procNFe.xml`);

let falharNoBanco = false;

/** Driver do Postgres que quebra sob demanda, para provar que o histórico não derruba a checagem. */
class PoolFake {
  static inserts = 0;

  on(): this {
    return this;
  }

  async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    if (falharNoBanco) throw new Error("connection terminated unexpectedly");
    if (sql.includes("INSERT INTO monitor.execucoes")) {
      PoolFake.inserts += 1;
      return { rows: [{ id: "00000000-0000-4000-8000-0000000000aa" }] };
    }
    return { rows: [] };
  }

  async connect(): Promise<{ query: PoolFake["query"]; release: () => void }> {
    return { query: (sql: string) => this.query(sql), release: () => {} };
  }

  async end(): Promise<void> {}
}

mock.module("pg", { defaultExport: { Pool: PoolFake } });
mock.module("./sftp.js", {
  namedExports: { listarArquivosFtp: async () => ARQUIVOS },
});
// Sem credenciais ML o job usa só o FTP — é o cenário que este teste exercita.
process.env.ML_TOKENS_PATH = "/tmp/monitor-sftp-tokens-inexistentes.json";
delete process.env.ML_ACCESS_TOKEN;
delete process.env.ML_REFRESH_TOKEN;
delete process.env.FAKE_NOTA;

process.env.MONITOR_DB_HOST = "postgres";
process.env.MONITOR_DB_DATABASE = "n8n";
process.env.MONITOR_DB_USER = "n8n_app";

const { executarJob } = await import("./job.js");

function config(): AppConfig {
  return {
    cliente: { nome: "Cliente Teste", conta: "123", canal: "Mercado Livre" },
    sftp: { host: "x", porta: 22, usuario: "x", senha: "x", diretorios: ["/xml"] },
    series: [{ numero: 2, nota_inicial: 6349 }],
    webhooks: {},
    http: {},
  };
}

test("executarJob grava a execução no histórico", async () => {
  falharNoBanco = false;
  PoolFake.inserts = 0;

  const resultado = await executarJob(config(), { notificar: false });
  assert.notEqual(resultado, "ocupado");
  assert.equal(PoolFake.inserts, 1);
});

test("executarJob devolve o resultado normalmente quando a gravação falha", async () => {
  falharNoBanco = true;

  const resultado = await executarJob(config(), { notificar: false });
  assert.notEqual(resultado, "ocupado");
  if (resultado === "ocupado") return;

  assert.equal(resultado.identificador, "Cliente: Cliente Teste - Conta 123");
  assert.equal(resultado.integracaoOk, false);
  assert.deepEqual(resultado.notasAusentes, [{ numero: 6350, serie: 2 }]);
  assert.equal(resultado.series.length, 1);
  assert.equal(resultado.series[0]?.max, 6351);
});
