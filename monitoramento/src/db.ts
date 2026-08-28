import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { parseFakeNota } from "./gaps.js";
import type { ResultadoJob } from "./job.js";
import type { ProximaAcao, RelatorioDiagnostico } from "./diagnostico.js";

export type ResultadoFinal = "resolvido" | "em_andamento" | "precisa_atencao";

export type HistoricoResumo = {
  periodo: { dias: number; desde: string; ate: string };
  execucoes: { total: number; comFuro: number; integracaoOkPct: number };
  diagnosticos: { total: number; resolvidos: number; precisaAtencao: number };
  serieMaisAfetada: { serie: number; totalAusentesSomado: number } | null;
};

let pool: pg.Pool | null = null;

/**
 * Histórico é opcional: sem MONITOR_DB_HOST o monitor roda igual a antes,
 * só não grava nada. O aviso sai uma vez, na subida (ver iniciarBanco).
 */
export function bancoConfigurado(): boolean {
  return Boolean(process.env.MONITOR_DB_HOST?.trim());
}

function conexao(): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({
    host: process.env.MONITOR_DB_HOST?.trim(),
    port: Number(process.env.MONITOR_DB_PORT?.trim() || "5432"),
    database: process.env.MONITOR_DB_DATABASE?.trim(),
    user: process.env.MONITOR_DB_USER?.trim(),
    password: process.env.MONITOR_DB_PASSWORD,
    max: 4,
    connectionTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  // Cliente ocioso derrubado pelo servidor emite 'error' no pool; sem listener
  // o processo cairia por unhandled error.
  pool.on("error", (erro) => {
    console.error(`▶ Histórico: conexão ociosa caiu — ${msg(erro)}`);
  });
  return pool;
}

function msg(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

/** AAAAMMDD (formato do teto ML) para DATE do Postgres. */
function dataIso(yyyymmdd?: string | null): string | null {
  const v = String(yyyymmdd ?? "").trim();
  if (!/^\d{8}$/.test(v)) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

function fakeNotaAtiva(): string | null {
  const fake = parseFakeNota(process.env.FAKE_NOTA);
  return fake ? `${fake.numero}/${fake.serie}` : null;
}

/**
 * Cria o schema (idempotente) e avisa uma única vez quando o histórico está
 * desligado. Nunca lança: banco fora do ar não impede o monitor de subir.
 */
export async function iniciarBanco(): Promise<void> {
  if (!bancoConfigurado()) {
    console.warn(
      "▶ MONITOR_DB_HOST não definido — histórico desativado (execuções e diagnósticos não serão gravados).",
    );
    return;
  }
  const caminho = join(dirname(fileURLToPath(import.meta.url)), "db-schema.sql");
  try {
    await conexao().query(readFileSync(caminho, "utf8"));
    console.log("▶ Histórico pronto (schema monitor)");
  } catch (erro) {
    console.error(`▶ Histórico indisponível — falha ao aplicar o schema: ${msg(erro)}`);
  }
}

export async function encerrarBanco(): Promise<void> {
  const atual = pool;
  pool = null;
  if (atual) await atual.end().catch(() => undefined);
}

/** Grava a execução e uma linha por série. Retorna o id, ou null se não gravou. */
export async function persistirExecucao(resultado: ResultadoJob): Promise<string | null> {
  if (!bancoConfigurado()) return null;
  let cliente: pg.PoolClient | undefined;
  try {
    cliente = await conexao().connect();
    await cliente.query("BEGIN");
    const { rows } = await cliente.query<{ id: string }>(
      `INSERT INTO monitor.execucoes
         (identificador, integracao_ok, total_ausentes, teto_periodo_ini, teto_periodo_fim, fake_nota, resultado_bruto)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        resultado.identificador,
        resultado.integracaoOk,
        resultado.notasAusentes.length,
        dataIso(resultado.tetoPeriodo?.start),
        dataIso(resultado.tetoPeriodo?.end),
        fakeNotaAtiva(),
        JSON.stringify(resultado),
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("INSERT em monitor.execucoes não devolveu id");

    for (const serie of resultado.series) {
      await cliente.query(
        `INSERT INTO monitor.series_resultado
           (execucao_id, serie, cnpj, total, min_numero, max_numero, teto_ml, ultima_ml_no_ftp, total_ausentes, pulos)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          serie.serie,
          serie.cnpj || null,
          serie.total,
          serie.min,
          serie.max,
          serie.tetoMl ?? null,
          serie.ultimaMlNoFtp ?? null,
          serie.totalAusentes,
          JSON.stringify(serie.pulos ?? []),
        ],
      );
    }

    await cliente.query("COMMIT");
    return id;
  } catch (erro) {
    await cliente?.query("ROLLBACK").catch(() => undefined);
    console.error(`▶ Histórico: falha ao gravar a execução — ${msg(erro)}`);
    return null;
  } finally {
    cliente?.release();
  }
}

export async function persistirDiagnostico(relatorio: RelatorioDiagnostico): Promise<string | null> {
  if (!bancoConfigurado()) return null;
  try {
    const { rows } = await conexao().query<{ id: string }>(
      `INSERT INTO monitor.diagnosticos
         (invoice_id, chave, numero, serie, notificacao_recebida, entrega_enviada, precisa_admin, proxima_acao, relatorio_bruto)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        relatorio.invoiceId,
        relatorio.chave,
        relatorio.numero,
        relatorio.serie,
        relatorio.notificacaoRecebida,
        relatorio.entregaEnviada,
        relatorio.precisaAdmin,
        relatorio.proximaAcao,
        JSON.stringify(relatorio),
      ],
    );
    return rows[0]?.id ?? null;
  } catch (erro) {
    console.error(`▶ Histórico: falha ao gravar o diagnóstico — ${msg(erro)}`);
    return null;
  }
}

/** Fecha o diagnóstico já gravado com o desfecho da recheca de entrega. */
export async function atualizarDiagnostico(
  id: string,
  resultadoFinal: ResultadoFinal,
  relatorio: RelatorioDiagnostico,
): Promise<void> {
  if (!bancoConfigurado()) return;
  try {
    await conexao().query(
      `UPDATE monitor.diagnosticos
          SET atualizado_em = now(),
              entrega_enviada = $2,
              precisa_admin = $3,
              proxima_acao = $4,
              resultado_final = $5,
              relatorio_bruto = $6
        WHERE id = $1`,
      [
        id,
        relatorio.entregaEnviada,
        relatorio.precisaAdmin,
        relatorio.proximaAcao,
        resultadoFinal,
        JSON.stringify(relatorio),
      ],
    );
  } catch (erro) {
    console.error(`▶ Histórico: falha ao atualizar o diagnóstico ${id} — ${msg(erro)}`);
  }
}

/** Relatório como foi gravado no POST /diagnostico, para recompor o desfecho. */
export async function buscarDiagnostico(id: string): Promise<RelatorioDiagnostico | null> {
  if (!bancoConfigurado()) return null;
  try {
    const { rows } = await conexao().query<{ relatorio_bruto: RelatorioDiagnostico }>(
      "SELECT relatorio_bruto FROM monitor.diagnosticos WHERE id = $1",
      [id],
    );
    return rows[0]?.relatorio_bruto ?? null;
  } catch (erro) {
    console.error(`▶ Histórico: falha ao ler o diagnóstico ${id} — ${msg(erro)}`);
    return null;
  }
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function consultarHistorico(dias: number): Promise<HistoricoResumo> {
  const janela = Number.isFinite(dias) && dias > 0 ? Math.floor(dias) : 7;
  const ate = new Date();
  const desde = new Date(ate.getTime() - janela * 24 * 60 * 60 * 1000);
  const periodo = { dias: janela, desde: iso(desde), ate: iso(ate) };
  const vazio: HistoricoResumo = {
    periodo,
    execucoes: { total: 0, comFuro: 0, integracaoOkPct: 0 },
    diagnosticos: { total: 0, resolvidos: 0, precisaAtencao: 0 },
    serieMaisAfetada: null,
  };
  if (!bancoConfigurado()) return vazio;

  const corte = `${janela} days`;
  const db = conexao();

  const execucoes = await db.query<{ total: string; com_furo: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE integracao_ok IS FALSE) AS com_furo
       FROM monitor.execucoes
      WHERE iniciado_em >= now() - $1::interval`,
    [corte],
  );
  const diagnosticos = await db.query<{ total: string; resolvidos: string; precisa_atencao: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE resultado_final = 'resolvido') AS resolvidos,
            count(*) FILTER (WHERE resultado_final = 'precisa_atencao') AS precisa_atencao
       FROM monitor.diagnosticos
      WHERE criado_em >= now() - $1::interval`,
    [corte],
  );
  // total_ausentes = -1 marca série sem nenhum XML; GREATEST evita subtrair do somatório.
  const serie = await db.query<{ serie: number; total_ausentes_somado: string }>(
    `SELECT s.serie, sum(GREATEST(s.total_ausentes, 0)) AS total_ausentes_somado
       FROM monitor.series_resultado s
       JOIN monitor.execucoes e ON e.id = s.execucao_id
      WHERE e.iniciado_em >= now() - $1::interval
      GROUP BY s.serie
     HAVING sum(GREATEST(s.total_ausentes, 0)) > 0
      ORDER BY total_ausentes_somado DESC, s.serie ASC
      LIMIT 1`,
    [corte],
  );

  const totalExec = Number(execucoes.rows[0]?.total ?? 0);
  const comFuro = Number(execucoes.rows[0]?.com_furo ?? 0);
  return {
    periodo,
    execucoes: {
      total: totalExec,
      comFuro,
      integracaoOkPct: totalExec ? Math.round(((totalExec - comFuro) / totalExec) * 1000) / 10 : 0,
    },
    diagnosticos: {
      total: Number(diagnosticos.rows[0]?.total ?? 0),
      resolvidos: Number(diagnosticos.rows[0]?.resolvidos ?? 0),
      precisaAtencao: Number(diagnosticos.rows[0]?.precisa_atencao ?? 0),
    },
    serieMaisAfetada: serie.rows[0]
      ? {
          serie: Number(serie.rows[0].serie),
          totalAusentesSomado: Number(serie.rows[0].total_ausentes_somado),
        }
      : null,
  };
}
