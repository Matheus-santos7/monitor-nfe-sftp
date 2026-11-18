import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./types.js";
import { executarJob, jobOcupado, statusPainel } from "./job.js";
import { PAINEL_HTML } from "./painel.js";
import { diaDe, lerDia, listarDias, resumirDia } from "./historico.js";
import { depsOrquestradorReais, dispararCiclo, estadoCiclo, type DepsOrquestrador } from "./orquestrador.js";
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

function igual(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Sem token configurado, nega tudo (fail-closed): POST /ciclo dispara contingência real. */
export function autorizado(req: IncomingMessage, token?: string, url?: URL): boolean {
  if (!token) return false;
  if (igual(req.headers.authorization, `Bearer ${token}`)) return true;
  if (igual(req.headers["x-token"], token)) return true;
  // ?token= só no /painel (abrir no navegador); nas demais rotas vazaria em log de proxy.
  if (url?.pathname === "/painel" && igual(url.searchParams.get("token"), token)) return true;
  return false;
}

export function intervaloPainelMin(): number {
  const v = Number(process.env.PAINEL_INTERVALO_MIN ?? 5);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function iniciarHttp(config: AppConfig): void {
  const porta = Number(process.env.PORT ?? config.http?.porta ?? 8080);
  const host = "0.0.0.0";

  const server = createServer((req, res) => {
    // Nenhum erro de rota pode virar unhandled rejection (derrubaria o processo e o painel).
    rotear(config, req, res).catch((erro) => {
      console.error(`▶ Erro inesperado em ${req.method} ${req.url}: ${msgErro(erro)}`);
      if (!res.headersSent) json(res, 500, { ok: false, erro: "erro interno" });
      else res.end();
    });
  });

  server.listen(porta, host, () => {
    console.log(`▶ monitor-sftp pronto :${porta}`);
  });
}

let depsManual: DepsOrquestrador | undefined;

async function rotear(config: AppConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health" && req.method === "GET") {
    json(res, 200, { ok: true, ocupado: jobOcupado() });
    return;
  }

  if (url.pathname === "/painel" && req.method === "GET") {
    if (!autorizado(req, tokenMonitor(config), url)) {
      json(res, 401, { ok: false, erro: tokenMonitor(config) ? "token inválido (use /painel?token=...)" : "defina MONITOR_HTTP_TOKEN no .env" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer", // o token está na URL do painel
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow", // painel interno com dados fiscais: nunca indexar
    });
    res.end(PAINEL_HTML);
    return;
  }

  if (url.pathname === "/status" && req.method === "GET") {
    if (!autorizado(req, tokenMonitor(config), url)) {
      json(res, 401, { ok: false, erro: tokenMonitor(config) ? "token inválido" : "defina MONITOR_HTTP_TOKEN no .env" });
      return;
    }
    json(res, 200, {
      ok: true,
      ocupado: jobOcupado(),
      intervaloMin: intervaloPainelMin(),
      cliente: config.cliente,
      ciclo: estadoCiclo(),
      ...statusPainel(),
    });
    return;
  }

  if (url.pathname === "/historico" && req.method === "GET") {
    if (!autorizado(req, tokenMonitor(config), url)) {
      json(res, 401, { ok: false, erro: tokenMonitor(config) ? "token inválido" : "defina MONITOR_HTTP_TOKEN no .env" });
      return;
    }
    const dia = url.searchParams.get("dia") ?? diaDe(new Date());
    if (!/^\d{8}$/.test(dia)) {
      json(res, 400, { ok: false, erro: "dia deve ser AAAAMMDD" });
      return;
    }
    const d = lerDia(dia);
    json(res, 200, { ok: true, dia, dias: listarDias(), resumo: d ? resumirDia(d) : null, ...(d ?? {}) });
    return;
  }

  if (url.pathname === "/ciclo/agora" && req.method === "POST") {
    if (!autorizado(req, tokenMonitor(config), url)) {
      json(res, 401, { ok: false, erro: tokenMonitor(config) ? "token inválido" : "defina MONITOR_HTTP_TOKEN no .env" });
      return;
    }
    const { modo } = estadoCiclo();
    if (modo === "off") {
      json(res, 409, { ok: false, erro: "agenda desligada (MODO_AGENDA=off): o monitor está pausado" });
      return;
    }
    depsManual ??= depsOrquestradorReais(config);
    const iniciado = dispararCiclo(depsManual, { origem: "manual", sombra: modo === "sombra" });
    json(res, iniciado ? 202 : 409, iniciado ? { ok: true, ciclo: estadoCiclo() } : { ok: false, erro: "já há um ciclo em andamento" });
    return;
  }

  if (url.pathname === "/ml/teto" && req.method === "GET") {
    if (!autorizado(req, tokenMonitor(config), url)) {
      json(res, 401, { ok: false, erro: tokenMonitor(config) ? "token inválido" : "defina MONITOR_HTTP_TOKEN no .env" });
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
      "use GET /health, GET /painel, GET /status, GET /historico, POST /ciclo/agora ou GET /ml/teto",
  });
}
