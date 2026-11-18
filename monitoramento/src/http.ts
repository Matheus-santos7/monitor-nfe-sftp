import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./types.js";
import { executarJob, jobOcupado, statusPainel } from "./job.js";
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

/** operacao = time técnico (Executar agora, /ml/teto) · leitura = time e cliente (status, histórico). */
export type Permissao = "operacao" | "leitura";
export type Tokens = { operacao?: string; leitura?: string };

function tokens(config: AppConfig): Tokens {
  return { operacao: tokenMonitor(config), leitura: process.env.PAINEL_TOKEN?.trim() || undefined };
}

/**
 * Sem token de operação configurado, nega tudo (fail-closed): o Executar agora pode disparar contingência real.
 * Só header (Authorization: Bearer ou X-Token); token na URL vazaria em log de proxy.
 */
export function permissao(req: IncomingMessage, t: Tokens): Permissao | null {
  if (!t.operacao) return null;
  const bate = (tok?: string) => !!tok && (igual(req.headers.authorization, `Bearer ${tok}`) || igual(req.headers["x-token"], tok));
  if (bate(t.operacao)) return "operacao";
  if (t.leitura && t.leitura !== t.operacao && bate(t.leitura)) return "leitura";
  return null;
}

/** Responde 401/403 e devolve null se o token não alcança o nível pedido. */
function exigir(req: IncomingMessage, res: ServerResponse, config: AppConfig, nivel: Permissao): Permissao | null {
  const t = tokens(config);
  const p = permissao(req, t);
  if (!p) {
    json(res, 401, { ok: false, erro: t.operacao ? "token inválido" : "defina MONITOR_HTTP_TOKEN no .env" });
    return null;
  }
  if (nivel === "operacao" && p !== "operacao") {
    json(res, 403, { ok: false, erro: "este token é só de leitura" });
    return null;
  }
  return p;
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

  if (url.pathname === "/status" && req.method === "GET") {
    const acesso = exigir(req, res, config, "leitura");
    if (!acesso) return;
    json(res, 200, {
      ok: true,
      ocupado: jobOcupado(),
      intervaloMin: intervaloPainelMin(),
      cliente: config.cliente,
      permissao: acesso,
      ciclo: estadoCiclo(),
      ...statusPainel(),
    });
    return;
  }

  if (url.pathname === "/historico" && req.method === "GET") {
    if (!exigir(req, res, config, "leitura")) return;
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
    if (!exigir(req, res, config, "operacao")) return;
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
    if (!exigir(req, res, config, "operacao")) return;
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
      "use GET /health, GET /status, GET /historico, POST /ciclo/agora ou GET /ml/teto (o painel fica no serviço painel)",
  });
}
