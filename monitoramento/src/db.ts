// Histórico também no MySQL 8 (banco padrão de monitoramento: sqlmonitoramento). Cópia consultável:
// o JSON por dia continua sendo a fonte do painel e dos alertas. Banco fora/lento NUNCA trava nem atrasa o ciclo:
// cada gravação é enfileirada e a falha vira aviso no painel ("histórico no banco indisponível").
import mysql from "mysql2/promise";
import type { EventoHistorico } from "./historico.js";

export const TABELAS_SQL = [
  `CREATE TABLE IF NOT EXISTS monitor_checagem (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    em DATETIME(3) NOT NULL,
    cliente VARCHAR(120) NOT NULL,
    status VARCHAR(20) NOT NULL,
    duracao_ms INT UNSIGNED NULL,
    notas_ausentes INT UNSIGNED NOT NULL DEFAULT 0,
    avisos TEXT NULL,
    KEY ix_checagem_cliente_em (cliente, em)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS monitor_evento (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    em DATETIME(3) NOT NULL,
    cliente VARCHAR(120) NOT NULL,
    tipo VARCHAR(30) NOT NULL,
    nota VARCHAR(30) NOT NULL DEFAULT '',
    texto VARCHAR(500) NOT NULL,
    duracao_min INT NULL,
    UNIQUE KEY ux_evento (cliente, em, tipo, nota),
    KEY ix_evento_cliente_tipo_em (cliente, tipo, em)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS monitor_ciclo (
    execucao VARCHAR(40) NOT NULL,
    cliente VARCHAR(120) NOT NULL,
    origem VARCHAR(10) NOT NULL,
    quem VARCHAR(64) NULL,
    sombra TINYINT(1) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL,
    inicio DATETIME(3) NOT NULL,
    fim DATETIME(3) NOT NULL,
    mensagens INT UNSIGNED NOT NULL DEFAULT 0,
    sem_entrega INT UNSIGNED NOT NULL DEFAULT 0,
    etapa_falha VARCHAR(60) NULL,
    erro VARCHAR(500) NULL,
    PRIMARY KEY (cliente, execucao),
    KEY ix_ciclo_cliente_inicio (cliente, inicio)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

type Executor = { execute: (sql: string, params?: unknown[]) => Promise<unknown> };

let pool: (Executor & { end: () => Promise<void> }) | null = null;
let fila: Promise<void> = Promise.resolve();
let ultimoErro: string | null = null;
let pendentes = 0;
const LIMITE_FILA = 1000; // banco fora por muito tempo: descarta o excedente (o JSON continua com tudo)

/** DB_HOST vazio = sem banco (desenvolvimento): todas as gravações viram no-op. */
export function bancoConfigurado(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.DB_HOST?.trim() && env.DB_USER?.trim());
}

/** Aviso para o painel quando o banco está falhando (nunca some calado). */
export function avisosBanco(): string[] {
  return ultimoErro ? [`Histórico no banco (${process.env.DB_NAME || "sqlmonitoramento"}) indisponível: ${ultimoErro}`] : [];
}

/** Para testes: troca o banco por um executor falso. */
export function _usarExecutor(e: Executor | null): void {
  pool = e ? { ...e, end: async () => undefined } : null;
  ultimoErro = null;
  pendentes = 0;
  fila = Promise.resolve();
}

/** Na subida: abre o pool e cria as tabelas (CREATE TABLE IF NOT EXISTS). Falha vira aviso, não derruba o monitor. */
export async function iniciarBanco(): Promise<void> {
  if (!bancoConfigurado()) return void console.log("▶ Histórico no MySQL desligado (DB_HOST vazio): só JSON");
  const p = mysql.createPool({
    host: process.env.DB_HOST!.trim(),
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER!.trim(),
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME?.trim() || "sqlmonitoramento",
    connectionLimit: 2,
    connectTimeout: 10_000,
    timezone: "Z", // DATETIME gravado em UTC
  });
  pool = { execute: (sql, params) => p.execute(sql, params as never), end: () => p.end() };
  try {
    for (const sql of TABELAS_SQL) await pool.execute(sql);
    ultimoErro = null;
    console.log(`▶ Histórico no MySQL: ${process.env.DB_HOST}/${process.env.DB_NAME || "sqlmonitoramento"} (tabelas ok)`);
  } catch (e) {
    ultimoErro = e instanceof Error ? e.message : String(e);
    console.error(`▶ Histórico no MySQL indisponível na subida: ${ultimoErro}`);
  }
}

/** Enfileira uma gravação; o chamador não espera. Erro → aviso no painel; sucesso limpa o aviso. */
function gravar(sqls: { sql: string; params: unknown[] }[]): void {
  if (!pool) return;
  if (pendentes >= LIMITE_FILA) return;
  pendentes++;
  const p = pool;
  fila = fila
    .then(async () => {
      for (const q of sqls) await p.execute(q.sql, q.params);
      ultimoErro = null;
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== ultimoErro) console.error(`▶ Histórico no MySQL: falha ao gravar (${msg})`);
      ultimoErro = msg;
    })
    .finally(() => {
      pendentes--;
    });
}

/** Para testes e para a migração: espera a fila esvaziar. */
export function esperarBanco(): Promise<void> {
  return fila;
}

const dt = (iso: string) => new Date(iso);

const sqlEvento = (cliente: string, e: EventoHistorico) => ({
  sql: "INSERT IGNORE INTO monitor_evento (em, cliente, tipo, nota, texto, duracao_min) VALUES (?, ?, ?, ?, ?, ?)",
  params: [dt(e.em), cliente, e.tipo, e.nota ?? "", e.texto.slice(0, 500), e.duracaoMin ?? null],
});

export function bancoChecagem(c: {
  em: string;
  cliente: string;
  status: string;
  duracaoMs: number | null;
  notasAusentes: number;
  avisos: string[];
  eventos: EventoHistorico[];
}): void {
  gravar([
    {
      sql: "INSERT INTO monitor_checagem (em, cliente, status, duracao_ms, notas_ausentes, avisos) VALUES (?, ?, ?, ?, ?, ?)",
      params: [dt(c.em), c.cliente, c.status, c.duracaoMs, c.notasAusentes, c.avisos.length ? c.avisos.join(" | ").slice(0, 4000) : null],
    },
    ...c.eventos.map((e) => sqlEvento(c.cliente, e)),
  ]);
}

export function bancoEventos(cliente: string, eventos: EventoHistorico[]): void {
  if (eventos.length) gravar(eventos.map((e) => sqlEvento(cliente, e)));
}

export function bancoCiclo(cliente: string, r: {
  execucao: string;
  origem: string;
  quem?: string;
  sombra: boolean;
  status: string;
  inicio: string;
  fim: string;
  mensagens: number;
  semEntrega: number;
  etapaFalha: string | null;
  erro: string | null;
}): void {
  gravar([
    {
      sql: `INSERT INTO monitor_ciclo (execucao, cliente, origem, quem, sombra, status, inicio, fim, mensagens, sem_entrega, etapa_falha, erro)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE status = VALUES(status), fim = VALUES(fim), mensagens = VALUES(mensagens),
              sem_entrega = VALUES(sem_entrega), etapa_falha = VALUES(etapa_falha), erro = VALUES(erro)`,
      params: [r.execucao, cliente, r.origem, r.quem ?? null, r.sombra ? 1 : 0, r.status, dt(r.inicio), dt(r.fim), r.mensagens, r.semEntrega, r.etapaFalha, r.erro?.slice(0, 500) ?? null],
    },
  ]);
}
