import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { ResultadoJob } from "./job.js";

type Chamada = { sql: string; params: unknown[] };
type Resposta = { rows: Record<string, unknown>[] };

const ID_FAKE = "00000000-0000-4000-8000-000000000001";

/** Pool do `pg` trocado por um dublê: nenhum teste abre conexão de verdade. */
class PoolFake {
  static criadas = 0;
  static ultima: PoolFake | null = null;

  chamadas: Chamada[] = [];
  releases = 0;
  responder: (sql: string, params: unknown[]) => Resposta = (sql) =>
    sql.includes("RETURNING id") ? { rows: [{ id: ID_FAKE }] } : { rows: [] };

  constructor(public readonly config: Record<string, unknown>) {
    PoolFake.criadas += 1;
    PoolFake.ultima = this;
  }

  on(): this {
    return this;
  }

  registrar(sql: string, params: unknown[]): Resposta {
    this.chamadas.push({ sql, params });
    return this.responder(sql, params);
  }

  async query(sql: string, params: unknown[] = []): Promise<Resposta> {
    return this.registrar(sql, params);
  }

  async connect(): Promise<{ query: PoolFake["query"]; release: () => void }> {
    return {
      query: async (sql: string, params: unknown[] = []) => this.registrar(sql, params),
      release: () => {
        this.releases += 1;
      },
    };
  }

  async end(): Promise<void> {}
}

mock.module("pg", { defaultExport: { Pool: PoolFake } });

const db = await import("./db.js");

function sqlDe(chamadas: Chamada[], trecho: string): Chamada[] {
  return chamadas.filter((c) => c.sql.includes(trecho));
}

function resultadoJob(over: Partial<ResultadoJob> = {}): ResultadoJob {
  return {
    identificador: "Cliente: Teste - Conta 123",
    integracaoOk: false,
    notasAusentes: [
      { numero: 6349, serie: 2 },
      { numero: 6350, serie: 2 },
    ],
    tetoPeriodo: { start: "20260821", end: "20260828" },
    series: [
      {
        serie: 2,
        cnpj: "00000000000191",
        total: 10,
        min: 6340,
        max: 6351,
        pulos: [{ inicio: 6349, fim: 6350, qtd: 2 }],
        totalAusentes: 2,
        tetoMl: 6351,
        ultimaMl: null,
        ultimaMlNoFtp: true,
      },
      {
        serie: 8,
        cnpj: "00000000000191",
        total: 4,
        min: 40,
        max: 43,
        pulos: [],
        totalAusentes: 0,
        tetoMl: null,
        ultimaMl: null,
        ultimaMlNoFtp: null,
      },
    ],
    ...over,
  };
}

async function comBanco<T>(fn: () => Promise<T>): Promise<T> {
  process.env.MONITOR_DB_HOST = "postgres";
  process.env.MONITOR_DB_DATABASE = "n8n";
  process.env.MONITOR_DB_USER = "n8n_app";
  process.env.MONITOR_DB_PASSWORD = "senha";
  try {
    return await fn();
  } finally {
    await db.encerrarBanco();
    delete process.env.MONITOR_DB_HOST;
  }
}

test("sem MONITOR_DB_HOST o histórico fica desligado e não abre conexão", async () => {
  delete process.env.MONITOR_DB_HOST;
  const criadasAntes = PoolFake.criadas;

  assert.equal(db.bancoConfigurado(), false);
  assert.equal(await db.persistirExecucao(resultadoJob()), null);
  assert.equal(
    await db.persistirDiagnostico({ invoiceId: "1" } as never),
    null,
  );
  assert.equal(await db.buscarDiagnostico("qualquer-id"), null);

  assert.equal(PoolFake.criadas, criadasAntes, "não deveria instanciar Pool");
});

test("persistirExecucao grava a execução e uma linha por série, em transação", async () => {
  const id = await comBanco(async () => {
    const gravado = await db.persistirExecucao(resultadoJob());
    const pool = PoolFake.ultima!;

    const execucao = sqlDe(pool.chamadas, "INSERT INTO monitor.execucoes")[0]!;
    assert.equal(execucao.params[0], "Cliente: Teste - Conta 123");
    assert.equal(execucao.params[1], false);
    assert.equal(execucao.params[2], 2, "total_ausentes vem de notasAusentes");
    assert.equal(execucao.params[3], "2026-08-21", "AAAAMMDD vira DATE");
    assert.equal(execucao.params[4], "2026-08-28");
    assert.equal(execucao.params[5], null, "sem FAKE_NOTA ativo");

    const series = sqlDe(pool.chamadas, "INSERT INTO monitor.series_resultado");
    assert.equal(series.length, 2);
    assert.deepEqual(
      series.map((s) => s.params[1]),
      [2, 8],
    );
    assert.equal(series[0]!.params[0], gravado, "série referencia a execução gravada");
    assert.deepEqual(JSON.parse(String(series[0]!.params[9])), [{ inicio: 6349, fim: 6350, qtd: 2 }]);

    assert.equal(sqlDe(pool.chamadas, "BEGIN").length, 1);
    assert.equal(sqlDe(pool.chamadas, "COMMIT").length, 1);
    assert.equal(sqlDe(pool.chamadas, "ROLLBACK").length, 0);
    assert.equal(pool.releases, 1, "cliente devolvido ao pool");
    return gravado;
  });
  assert.equal(typeof id, "string");
});

test("persistirExecucao devolve null e faz ROLLBACK quando o driver falha", async () => {
  await comBanco(async () => {
    // primeira query real (o INSERT) quebra, como um timeout de conexão
    const proximo = () => {
      const pool = PoolFake.ultima!;
      pool.responder = (sql) => {
        if (sql.includes("INSERT INTO monitor.execucoes")) throw new Error("connection terminated");
        return { rows: [] };
      };
    };
    // o pool só existe depois da primeira chamada; força a criação e arma a falha
    await db.buscarDiagnostico("id-qualquer");
    proximo();

    const id = await db.persistirExecucao(resultadoJob());
    assert.equal(id, null);

    const pool = PoolFake.ultima!;
    assert.equal(sqlDe(pool.chamadas, "ROLLBACK").length, 1);
    assert.equal(sqlDe(pool.chamadas, "INSERT INTO monitor.series_resultado").length, 0);
    assert.equal(pool.releases, 1);
  });
});

test("FAKE_NOTA ativo é ecoado na linha da execução", async () => {
  process.env.FAKE_NOTA = "6349/2";
  try {
    await comBanco(async () => {
      await db.persistirExecucao(resultadoJob());
      const execucao = sqlDe(PoolFake.ultima!.chamadas, "INSERT INTO monitor.execucoes")[0]!;
      assert.equal(execucao.params[5], "6349/2");
    });
  } finally {
    delete process.env.FAKE_NOTA;
  }
});

test("consultarHistorico agrega execuções, diagnósticos e série mais afetada", async () => {
  await comBanco(async () => {
    await db.buscarDiagnostico("cria-o-pool");
    PoolFake.ultima!.responder = (sql) => {
      if (sql.includes("FROM monitor.execucoes")) return { rows: [{ total: "56", com_furo: "3" }] };
      if (sql.includes("FROM monitor.diagnosticos")) {
        return { rows: [{ total: "5", resolvidos: "4", precisa_atencao: "1" }] };
      }
      if (sql.includes("FROM monitor.series_resultado")) {
        return { rows: [{ serie: 2, total_ausentes_somado: "7" }] };
      }
      return { rows: [] };
    };

    const resumo = await db.consultarHistorico(7);
    assert.equal(resumo.periodo.dias, 7);
    assert.match(resumo.periodo.desde, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(resumo.execucoes, { total: 56, comFuro: 3, integracaoOkPct: 94.6 });
    assert.deepEqual(resumo.diagnosticos, { total: 5, resolvidos: 4, precisaAtencao: 1 });
    assert.deepEqual(resumo.serieMaisAfetada, { serie: 2, totalAusentesSomado: 7 });
  });
});

test("consultarHistorico sem execuções não divide por zero", async () => {
  await comBanco(async () => {
    await db.buscarDiagnostico("cria-o-pool");
    PoolFake.ultima!.responder = () => ({ rows: [] });

    const resumo = await db.consultarHistorico(30);
    assert.equal(resumo.periodo.dias, 30);
    assert.deepEqual(resumo.execucoes, { total: 0, comFuro: 0, integracaoOkPct: 0 });
    assert.equal(resumo.serieMaisAfetada, null);
  });
});
