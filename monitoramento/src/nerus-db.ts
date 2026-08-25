import { Client } from "ssh2";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

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

export async function comMysqlNerus<T>(fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
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
    try {
      return await fn(conn);
    } finally {
      await conn.end();
    }
  } finally {
    ssh.end();
  }
}

export async function queryNerus<T extends Linha = Linha>(
  sql: string,
  params: Array<string | number | null> = [],
): Promise<T[]> {
  return comMysqlNerus(async (conn) => {
    const [rows] = await conn.execute(sql, params);
    return (Array.isArray(rows) ? rows : []) as T[];
  });
}
