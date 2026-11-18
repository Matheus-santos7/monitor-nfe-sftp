import { Client } from "ssh2";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

export type Linha = Record<string, unknown>;

function reqEnv(nome: string): string {
  const v = process.env[nome]?.trim();
  if (!v) throw new Error(`Defina ${nome} no .env`);
  return v;
}

export function configNerusDb() {
  return {
    sshHost: reqEnv("NERUS_SSH_HOST"),
    sshPort: Number(process.env.NERUS_SSH_PORT?.trim() || "22"),
    sshUser: reqEnv("NERUS_SSH_USER"),
    sshKeyPath: reqEnv("NERUS_SSH_KEY"),
    dbHost: reqEnv("NERUS_DB_HOST"),
    dbPort: Number(process.env.NERUS_DB_PORT?.trim() || "3306"),
    dbUser: reqEnv("NERUS_DB_USER"),
    dbPassword: reqEnv("NERUS_DB_PASSWORD"),
  };
}

const QUERY_TIMEOUT_MS = 30_000; // túnel travado não pode prender o /ciclo até o timeout de 600 s do n8n

type Aberta = { conn: mysql.Connection; fechar: () => Promise<void> };

async function abrirMysqlNerus(): Promise<Aberta> {
  const cfg = configNerusDb();
  const ssh = new Client();
  try {
    await new Promise<void>((resolve, reject) => {
      ssh
        .on("ready", () => resolve())
        .on("error", reject)
        .connect({
          host: cfg.sshHost,
          port: cfg.sshPort,
          username: cfg.sshUser,
          privateKey: readFileSync(cfg.sshKeyPath),
          readyTimeout: 20_000,
        });
    });

    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      ssh.forwardOut("127.0.0.1", 0, cfg.dbHost, cfg.dbPort, (err, s) => {
        if (err || !s) reject(err ?? new Error("túnel SSH recusado"));
        else resolve(s as unknown as NodeJS.ReadableStream);
      });
    });

    const conn = await mysql.createConnection({
      user: cfg.dbUser,
      password: cfg.dbPassword,
      stream: stream as import("node:net").Socket,
      connectTimeout: 20_000,
    });
    // Sem listener, um 'error' fatal (túnel caiu ocioso) derruba o processo; a próxima query já falha sozinha.
    conn.on("error", (erro) => console.error(`▶ Conexão MySQL Nerus: ${erro.message}`));
    return {
      conn,
      fechar: async () => {
        await conn.end().catch(() => undefined);
        ssh.end();
      },
    };
  } catch (erro) {
    ssh.end();
    throw erro;
  }
}

// Sessão = um túnel SSH + conexão MySQL reaproveitados por todas as queries dentro de `fn` (ex.: um /ciclo inteiro).
// Aberta na 1ª query; se falhar, as demais falham na hora com o mesmo erro (sem repetir o timeout de 20 s por NF).
const sessao = new AsyncLocalStorage<{ aberta?: Promise<Aberta> }>();

export async function comSessaoNerus<T>(fn: () => Promise<T>): Promise<T> {
  const s: { aberta?: Promise<Aberta> } = {};
  try {
    return await sessao.run(s, fn);
  } finally {
    await s.aberta?.then((a) => a.fechar(), () => undefined);
  }
}

export async function queryNerus<T extends Linha = Linha>(
  sql: string,
  params: Array<string | number | null> = [],
): Promise<T[]> {
  const s = sessao.getStore();
  let a: Aberta;
  if (s) a = await (s.aberta ??= abrirMysqlNerus());
  else a = await abrirMysqlNerus();
  try {
    const [rows] = await a.conn.execute({ sql, timeout: QUERY_TIMEOUT_MS }, params);
    return (Array.isArray(rows) ? rows : []) as T[];
  } finally {
    if (!s) await a.fechar();
  }
}
