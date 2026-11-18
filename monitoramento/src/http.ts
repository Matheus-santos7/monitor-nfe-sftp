import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AppConfig } from "./types.js";
import { executarJob, jobOcupado, statusPainel } from "./job.js";
import { PAINEL_HTML } from "./painel.js";
import { diaDe, lerDia, listarDias, resumirDia } from "./historico.js";
import { conferirLote, depsReais, rodarCiclo } from "./ciclo.js";
import type { ItemLote } from "./relatorio.js";
import { listarNotasAutorizadas, tetosPorSerie } from "./ml-invoices.js";

function msgErro(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

function logPasso(texto: string): void {
  console.log(`▶ ${texto}`);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function tokenMonitor(config: AppConfig): string | undefined {
  const env = process.env.MONITOR_HTTP_TOKEN?.trim();
  const cfg = typeof config.http?.token === "string" ? config.http.token.trim() : "";
  return env || cfg || undefined;
}

function autorizado(req: IncomingMessage, token?: string, url?: URL): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) return true;
  if (req.headers["x-token"] === token) return true;
  if (url?.searchParams.get("token") === token) return true;
  return false;
}

async function lerJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Valida a lista de NFs que volta do n8n (fronteira de confiança: corpo HTTP). */
export function lerNotas(v: unknown): { numero: number; serie: number }[] | null {
  if (!Array.isArray(v)) return null;
  const notas = v.map((n) => ({ numero: Number(n?.numero), serie: Number(n?.serie) }));
  return notas.every((n) => Number.isInteger(n.numero) && n.numero > 0 && Number.isInteger(n.serie) && n.serie > 0) ? notas : null;
}

export function intervaloPainelMin(): number {
  const v = Number(process.env.PAINEL_INTERVALO_MIN ?? 5);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function iniciarHttp(config: AppConfig): void {
  const porta = Number(process.env.PORT ?? config.http?.porta ?? 8080);
  const host = "0.0.0.0";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health" && req.method === "GET") {
      json(res, 200, { ok: true, ocupado: jobOcupado() });
      return;
    }

    if (url.pathname === "/painel" && req.method === "GET") {
      if (!autorizado(req, tokenMonitor(config), url)) {
        json(res, 401, { ok: false, erro: "token inválido (use /painel?token=...)" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(PAINEL_HTML);
      return;
    }

    if (url.pathname === "/status" && req.method === "GET") {
      if (!autorizado(req, tokenMonitor(config), url)) {
        json(res, 401, { ok: false, erro: "token inválido" });
        return;
      }
      json(res, 200, {
        ok: true,
        ocupado: jobOcupado(),
        intervaloMin: intervaloPainelMin(),
        cliente: config.cliente,
        ...statusPainel(),
      });
      return;
    }

    if (url.pathname === "/historico" && req.method === "GET") {
      if (!autorizado(req, tokenMonitor(config), url)) {
        json(res, 401, { ok: false, erro: "token inválido" });
        return;
      }
      const dia = url.searchParams.get("dia") ?? diaDe(new Date());
      const d = lerDia(dia);
      json(res, 200, { ok: true, dia, dias: listarDias(), resumo: d ? resumirDia(d) : null, ...(d ?? {}) });
      return;
    }

    if (url.pathname === "/ciclo" && req.method === "POST") {
      if (!autorizado(req, tokenMonitor(config), url)) {
        json(res, 401, { ok: false, erro: "token inválido" });
        return;
      }
      try {
        const body = await lerJson(req);
        logPasso("Ciclo: checar, diagnosticar e decidir espera");
        const r = await rodarCiclo(depsReais(config), String(body.execucao ?? ""));
        console.log(`   Ciclo: ${r.status}, ${r.lote.length} NF(s) no lote, espera ${r.espera}`);
        json(res, 200, { ok: true, ...r });
      } catch (erro) {
        console.error(`▶ Ciclo falhou: ${msgErro(erro)}`);
        json(res, 500, { ok: false, erro: msgErro(erro) });
      }
      return;
    }

    if (url.pathname === "/ciclo/conferir" && req.method === "POST") {
      if (!autorizado(req, tokenMonitor(config), url)) {
        json(res, 401, { ok: false, erro: "token inválido" });
        return;
      }
      try {
        const body = await lerJson(req);
        const notas = lerNotas(body.notas);
        if (!notas || !Array.isArray(body.lote)) {
          json(res, 400, { ok: false, erro: "informe notas[] ({numero, serie}) e lote[]" });
          return;
        }
        logPasso(`Ciclo: conferir ${notas.length} NF(s) no FTP`);
        const r = await conferirLote(depsReais(config), { notas, lote: body.lote as ItemLote[], execucao: String(body.execucao ?? "") });
        console.log(`   Conferência: ${r.noFtp}/${r.total} no FTP`);
        json(res, 200, { ok: true, ...r });
      } catch (erro) {
        console.error(`▶ Conferência falhou: ${msgErro(erro)}`);
        json(res, 500, { ok: false, erro: msgErro(erro) });
      }
      return;
    }

    if (url.pathname === "/ml/teto" && req.method === "GET") {
      if (!autorizado(req, tokenMonitor(config), url)) {
        json(res, 401, { ok: false, erro: "token inválido" });
        return;
      }
      try {
        logPasso("Consultar teto ML");
        const { start, end, notas } = await listarNotasAutorizadas({
          start: url.searchParams.get("start") ?? undefined,
          end: url.searchParams.get("end") ?? undefined,
        });
        const seriesFiltro = url.searchParams.get("series");
        const desejadas = seriesFiltro
          ? new Set(
              seriesFiltro
                .split(",")
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isFinite(n)),
            )
          : new Set(config.series.map((s) => s.numero));
        const tetos = tetosPorSerie(notas.filter((n) => desejadas.has(n.serie)));
        json(res, 200, {
          ok: true,
          start,
          end,
          tetos: Object.fromEntries([...tetos.entries()].map(([serie, t]) => [String(serie), t])),
        });
      } catch (erro) {
        console.error(`▶ Teto ML falhou: ${msgErro(erro)}`);
        json(res, 500, {
          ok: false,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      }
      return;
    }

    json(res, 404, {
      ok: false,
      erro:
        "use GET /health, GET /painel, GET /status, GET /historico, POST /ciclo, POST /ciclo/conferir ou GET /ml/teto",
    });
  });

  server.listen(porta, host, () => {
    console.log(`▶ monitor-sftp pronto :${porta}`);
  });
}
