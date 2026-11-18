import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./types.js";
import { executarJob, jobOcupado, statusPainel } from "./job.js";
import { PAINEL_HTML } from "./painel.js";
import { diaDe, lerDia, listarDias, resumirDia } from "./historico.js";
import { conferirLote, depsReais, rodarCiclo } from "./ciclo.js";
import { depsOrquestradorReais, dispararCiclo, estadoCiclo, type DepsOrquestrador } from "./orquestrador.js";
import type { ItemLote } from "./relatorio.js";
import type { Passo, ProximaAcao } from "./diagnostico.js";
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

/** Erro de entrada do cliente (corpo inválido/grande) → 4xx em vez de 500. */
export class ErroEntrada extends Error {
  constructor(
    readonly status: 400 | 413,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

const LIMITE_CORPO = 1_000_000;

async function lerJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let tamanho = 0;
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    tamanho += b.length;
    if (tamanho > LIMITE_CORPO) throw new ErroEntrada(413, "corpo maior que 1 MB");
    chunks.push(b);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ErroEntrada(400, "JSON inválido");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ErroEntrada(400, "o corpo deve ser um objeto JSON");
  return v as Record<string, unknown>;
}

const MAX_NOTAS = 500;
const inteiroPositivo = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const texto = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const ACOES = new Set<ProximaAcao>(["nenhuma", "esperar_entrega", "contigencia", "rechecar_ftp"]);
const STATUS_PASSO = new Set<Passo["status"]>(["ok", "alerta", "erro", "info"]);

/** Valida a lista de NFs que volta do n8n (fronteira de confiança: corpo HTTP). Vazia ou inválida = null. */
export function lerNotas(v: unknown): { numero: number; serie: number }[] | null {
  if (!Array.isArray(v) || !v.length || v.length > MAX_NOTAS) return null;
  const notas: { numero: number; serie: number }[] = [];
  for (const n of v) {
    if (!n || typeof n !== "object" || !inteiroPositivo(n.numero) || !inteiroPositivo(n.serie)) return null;
    notas.push({ numero: n.numero, serie: n.serie });
  }
  return notas;
}

/** Valida o lote que volta do n8n: só repassa campos com o tipo certo para os relatórios. Inválido = null. */
export function lerLote(v: unknown): ItemLote[] | null {
  if (!Array.isArray(v) || v.length > MAX_NOTAS) return null;
  const lote: ItemLote[] = [];
  for (const i of v) {
    if (!i || typeof i !== "object" || !inteiroPositivo(i.numero) || !inteiroPositivo(i.serie)) return null;
    const passos = Array.isArray(i.passos)
      ? i.passos
          .filter((p: unknown): p is Record<string, unknown> => !!p && typeof p === "object")
          .map((p: Record<string, unknown>) => ({
            id: texto(p.id) ?? "",
            titulo: texto(p.titulo) ?? "",
            status: STATUS_PASSO.has(p.status as Passo["status"]) ? (p.status as Passo["status"]) : "info",
            detalhe: texto(p.detalhe) ?? "",
          }))
      : undefined;
    const rastro = Array.isArray(i.rastro)
      ? i.rastro
          .filter((r: unknown): r is Record<string, unknown> => !!r && typeof r === "object")
          .map((r: Record<string, unknown>) => ({
            n: Number(r.n) || 0,
            tabela: texto(r.tabela) ?? "",
            executado: r.executado === true,
            filtro: texto(r.filtro) ?? "",
            linhas: Number(r.linhas) || 0,
            detalhe: texto(r.detalhe) ?? "",
          }))
      : undefined;
    const c = i.contigencia;
    lote.push({
      referencia: texto(i.referencia) ?? `${i.numero}/${i.serie}`,
      numero: i.numero,
      serie: i.serie,
      invoiceId: texto(i.invoiceId) ?? null,
      chave: texto(i.chave) ?? null,
      proximaAcao: ACOES.has(i.proximaAcao) ? i.proximaAcao : "nenhuma",
      diagnostico: texto(i.diagnostico) ?? "",
      passos,
      contigencia:
        c && typeof c === "object" && typeof c.notificationId === "string"
          ? { notificationId: c.notificationId, httpStatus: Number(c.httpStatus) || 0 }
          : null,
      rastro,
      mensagem: texto(i.mensagem),
    });
  }
  return lote;
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
      if (erro instanceof ErroEntrada) {
        if (!res.headersSent) json(res, erro.status, { ok: false, erro: erro.message });
        return;
      }
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

  if (url.pathname === "/ciclo" && req.method === "POST") {
    if (!autorizado(req, tokenMonitor(config), url)) {
      json(res, 401, { ok: false, erro: tokenMonitor(config) ? "token inválido" : "defina MONITOR_HTTP_TOKEN no .env" });
      return;
    }
    try {
      const body = await lerJson(req);
      logPasso("Ciclo: checar, diagnosticar e decidir espera");
      const r = await rodarCiclo(depsReais(config), String(body.execucao ?? ""));
      console.log(`   Ciclo: ${r.status}, ${r.lote.length} NF(s) no lote, espera ${r.espera}`);
      json(res, 200, { ok: true, ...r });
    } catch (erro) {
      if (erro instanceof ErroEntrada) throw erro;
      console.error(`▶ Ciclo falhou: ${msgErro(erro)}`);
      json(res, 500, { ok: false, erro: msgErro(erro) });
    }
    return;
  }

  if (url.pathname === "/ciclo/agora" && req.method === "POST") {
    if (!autorizado(req, tokenMonitor(config), url)) {
      json(res, 401, { ok: false, erro: tokenMonitor(config) ? "token inválido" : "defina MONITOR_HTTP_TOKEN no .env" });
      return;
    }
    const { modo } = estadoCiclo();
    if (modo === "off") {
      // com o n8n agendando, uma rodada daqui somaria contingência e avisos aos dele
      json(res, 409, { ok: false, erro: 'agenda desligada (MODO_AGENDA=off): use o "Executar agora" do n8n' });
      return;
    }
    depsManual ??= depsOrquestradorReais(config);
    const iniciado = dispararCiclo(depsManual, { origem: "manual", sombra: modo === "sombra" });
    json(res, iniciado ? 202 : 409, iniciado ? { ok: true, ciclo: estadoCiclo() } : { ok: false, erro: "já há um ciclo em andamento" });
    return;
  }

  if (url.pathname === "/ciclo/conferir" && req.method === "POST") {
    if (!autorizado(req, tokenMonitor(config), url)) {
      json(res, 401, { ok: false, erro: tokenMonitor(config) ? "token inválido" : "defina MONITOR_HTTP_TOKEN no .env" });
      return;
    }
    try {
      const body = await lerJson(req);
      const notas = lerNotas(body.notas);
      const lote = lerLote(body.lote);
      if (!notas || !lote) {
        json(res, 400, { ok: false, erro: "informe notas[] (1–500 itens {numero, serie} inteiros) e lote[] (itens com numero e serie)" });
        return;
      }
      logPasso(`Ciclo: conferir ${notas.length} NF(s) no FTP`);
      const r = await conferirLote(depsReais(config), { notas, lote, execucao: String(body.execucao ?? "") });
      console.log(`   Conferência: ${r.noFtp}/${r.total} no FTP`);
      json(res, 200, { ok: true, ...r });
    } catch (erro) {
      if (erro instanceof ErroEntrada) throw erro;
      console.error(`▶ Conferência falhou: ${msgErro(erro)}`);
      json(res, 500, { ok: false, erro: msgErro(erro) });
    }
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
      "use GET /health, GET /painel, GET /status, GET /historico, POST /ciclo, POST /ciclo/agora, POST /ciclo/conferir ou GET /ml/teto",
  });
}
