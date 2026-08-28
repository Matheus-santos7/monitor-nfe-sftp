import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./types.js";
import { executarJob, jobOcupado } from "./job.js";
import { localizarInvoicePorNf, listarNotasAutorizadas, tetosPorSerie, validarUsuarioMl } from "./ml-invoices.js";
import {
  consultarEstadoNerus,
  diagnosticarNota,
  classificarEntregas,
  concluirRelatorio,
  type RelatorioDiagnostico,
} from "./diagnostico.js";
import {
  atualizarDiagnostico,
  bancoConfigurado,
  buscarDiagnostico,
  consultarHistorico,
  persistirDiagnostico,
} from "./db.js";

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

/**
 * Compara duas strings em tempo constante, para não vazar por timing
 * quanto do token está correto. Tamanhos diferentes já respondem falso,
 * mas só depois de comparar contra um buffer do mesmo tamanho do esperado
 * (evita atalho de curto-circuito revelando o tamanho certo do token).
 */
function iguaisSemTiming(recebido: string, esperado: string): boolean {
  const bufEsperado = Buffer.from(esperado, "utf8");
  const bufRecebido = Buffer.from(recebido, "utf8");
  if (bufRecebido.length !== bufEsperado.length) {
    // ainda assim compara algo de tamanho igual para manter o tempo estável
    timingSafeEqual(bufEsperado, bufEsperado);
    return false;
  }
  return timingSafeEqual(bufRecebido, bufEsperado);
}

function autorizado(req: IncomingMessage, token?: string, url?: URL): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ") && iguaisSemTiming(header.slice(7), token)) {
    return true;
  }
  const xToken = req.headers["x-token"];
  if (typeof xToken === "string" && iguaisSemTiming(xToken, token)) return true;
  const qToken = url?.searchParams.get("token");
  if (typeof qToken === "string" && iguaisSemTiming(qToken, token)) return true;
  return false;
}

// ---- Rate limit de tentativas de autenticação inválidas ----
// Protege contra tentativa de adivinhar o token por força bruta.
// Não limita requisições autorizadas — só falhas de auth.
const JANELA_MS = 5 * 60 * 1000;
const MAX_FALHAS = 20;
const tentativasPorIp = new Map<string, { falhas: number; desde: number }>();

function ipDoRequest(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0]!.trim();
  return req.socket.remoteAddress || "desconhecido";
}

function bloqueadoPorFalhas(ip: string): boolean {
  const registro = tentativasPorIp.get(ip);
  if (!registro) return false;
  if (Date.now() - registro.desde > JANELA_MS) {
    tentativasPorIp.delete(ip);
    return false;
  }
  return registro.falhas >= MAX_FALHAS;
}

function registrarFalhaAuth(ip: string): void {
  const registro = tentativasPorIp.get(ip);
  if (!registro || Date.now() - registro.desde > JANELA_MS) {
    tentativasPorIp.set(ip, { falhas: 1, desde: Date.now() });
    return;
  }
  registro.falhas += 1;
}

/** true = seguiu em frente; false = já respondeu (bloqueado ou não autorizado). */
function checarAuth(req: IncomingMessage, res: ServerResponse, config: AppConfig, url: URL): boolean {
  const token = tokenMonitor(config);
  const ip = ipDoRequest(req);
  if (token && bloqueadoPorFalhas(ip)) {
    json(res, 429, { ok: false, erro: "muitas tentativas de autenticação inválidas — aguarde alguns minutos" });
    return false;
  }
  if (!autorizado(req, token, url)) {
    if (token) registrarFalhaAuth(ip);
    json(res, 401, { ok: false, erro: "token inválido" });
    return false;
  }
  return true;
}

async function lerJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Fecha no histórico o diagnóstico aberto pelo POST /diagnostico. O desfecho vem
 * de concluirRelatorio — a mesma função que monta o texto — para não existirem
 * duas versões da decisão.
 */
async function fecharDiagnostico(
  diagnosticoId: string,
  estado: Awaited<ReturnType<typeof consultarEstadoNerus>>,
  entrega: ReturnType<typeof classificarEntregas>,
): Promise<void> {
  try {
    const anterior = await buscarDiagnostico(diagnosticoId);
    if (!anterior) return;
    const atualizado: RelatorioDiagnostico = {
      ...anterior,
      entregaEnviada: entrega === "enviada",
      invoice: estado.invoice,
      entregas: estado.entregas,
      rastro: estado.rastro,
    };
    const final = concluirRelatorio(atualizado, { classificacaoEntregaAposEspera: entrega });
    await atualizarDiagnostico(diagnosticoId, final.resultadoFinal, {
      ...atualizado,
      precisaAdmin: final.precisaAdmin,
      assunto: final.assunto,
      mensagem: final.mensagem,
    });
  } catch (erro) {
    console.error(`▶ Histórico: falha ao fechar o diagnóstico ${diagnosticoId}: ${msgErro(erro)}`);
  }
}

async function responderEntrega(
  res: ServerResponse,
  params: { invoiceId: string; chave?: string | null; mlUserId?: string; diagnosticoId?: string },
): Promise<void> {
  const invoiceId = String(params.invoiceId ?? "").trim();
  const chave = params.chave ? String(params.chave) : null;
  const mlUserId = params.mlUserId || process.env.ML_USER_ID || "";
  const tenantId = process.env.NERUS_TENANT_ID || "";
  const diagnosticoId = params.diagnosticoId?.trim();
  if (!invoiceId) {
    json(res, 400, { ok: false, erro: "informe invoiceId" });
    return;
  }
  try {
    const estado = await consultarEstadoNerus({
      invoiceId,
      chave,
      mlUserId,
      tenantId,
    });
    const entrega = classificarEntregas(estado.entregas);
    if (diagnosticoId) await fecharDiagnostico(diagnosticoId, estado, entrega);
    json(res, 200, {
      ok: true,
      notificacaoRecebida: Boolean(estado.notificacao),
      invoice: estado.invoice,
      entregas: estado.entregas,
      entregaEnviada: entrega === "enviada",
      classificacaoEntrega: entrega,
      rastro: estado.rastro,
    });
  } catch (erro) {
    console.error(`▶ Entrega Nerus falhou: ${msgErro(erro)}`);
    json(res, 500, {
      ok: false,
      erro: msgErro(erro),
    });
  }
}

export function iniciarHttp(config: AppConfig): ReturnType<typeof createServer> {
  const porta = Number(process.env.PORT ?? config.http?.porta ?? 8080);
  const host = "0.0.0.0";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health" && req.method === "GET") {
      json(res, 200, { ok: true, ocupado: jobOcupado() });
      return;
    }

    if (url.pathname === "/executar" && (req.method === "POST" || req.method === "GET")) {
      if (!checarAuth(req, res, config, url)) {
        return;
      }

      try {
        const notificar = url.searchParams.get("notify") !== "false";
        logPasso(notificar ? "Checar FTP e teto ML" : "Rechecar FTP");
        const resultado = await executarJob(config, { notificar });
        if (resultado === "ocupado") {
          json(res, 409, { ok: false, erro: "já existe uma checagem em andamento" });
          return;
        }
        json(res, 200, { ok: true, ...resultado });
      } catch (erro) {
        console.error(`▶ Checar FTP falhou: ${msgErro(erro)}`);
        json(res, 500, {
          ok: false,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      }
      return;
    }

    if (url.pathname === "/ml/me" && req.method === "GET") {
      if (!checarAuth(req, res, config, url)) {
        return;
      }
      try {
        logPasso("Validar token Mercado Livre");
        const me = await validarUsuarioMl();
        json(res, 200, { ok: true, id: me.id });
      } catch (erro) {
        console.error(`▶ Validar token ML falhou: ${msgErro(erro)}`);
        json(res, 500, {
          ok: false,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      }
      return;
    }

    if (url.pathname === "/ml/invoice" && req.method === "GET") {
      if (!checarAuth(req, res, config, url)) {
        return;
      }
      const numero = Number(url.searchParams.get("numero"));
      const serie = Number(url.searchParams.get("serie"));
      if (!Number.isFinite(numero) || !Number.isFinite(serie) || numero <= 0 || serie <= 0) {
        json(res, 400, { ok: false, erro: "informe numero e serie da NF-e" });
        return;
      }
      try {
        logPasso(`Localizar invoice no ZIP do ML (${numero}/${serie})`);
        const resultado = await localizarInvoicePorNf({
          numero,
          serie,
          start: url.searchParams.get("start") ?? undefined,
          end: url.searchParams.get("end") ?? undefined,
        });
        json(res, 200, { ok: true, ...resultado });
      } catch (erro) {
        console.error(`▶ Localizar invoice ${numero}/${serie} falhou: ${msgErro(erro)}`);
        json(res, 500, {
          ok: false,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      }
      return;
    }

    if (url.pathname === "/ml/teto" && req.method === "GET") {
      if (!checarAuth(req, res, config, url)) {
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

    if (url.pathname === "/diagnostico" && req.method === "POST") {
      if (!checarAuth(req, res, config, url)) {
        return;
      }
      try {
        const body = await lerJson(req);
        const invoiceId = String(body.invoiceId ?? url.searchParams.get("invoiceId") ?? "").trim();
        const numero = Number(body.numero ?? url.searchParams.get("numero"));
        const serie = Number(body.serie ?? url.searchParams.get("serie"));
        if (!invoiceId || !Number.isFinite(numero) || !Number.isFinite(serie)) {
          json(res, 400, { ok: false, erro: "informe invoiceId, numero e serie" });
          return;
        }
        logPasso(`Diagnosticar no Nerus NF ${numero}/${serie} (invoice ${invoiceId})`);
        const relatorio = await diagnosticarNota({
          invoiceId,
          chave: body.chave ? String(body.chave) : null,
          numero,
          serie,
          mlUserId: body.mlUserId ? String(body.mlUserId) : undefined,
          executarContigencia: body.executarContigencia !== false,
        });
        const diagnosticoId = await persistirDiagnostico(relatorio);
        json(res, 200, { ok: true, ...relatorio, diagnosticoId });
      } catch (erro) {
        console.error(`▶ Diagnóstico Nerus falhou: ${msgErro(erro)}`);
        json(res, 500, {
          ok: false,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      }
      return;
    }

    if (url.pathname === "/diagnostico/entrega" && (req.method === "GET" || req.method === "POST")) {
      if (!checarAuth(req, res, config, url)) {
        return;
      }
      if (req.method === "POST") {
        const body = await lerJson(req);
        logPasso(`Rechecar entrega no Nerus (invoice ${String(body.invoiceId ?? "")})`);
        await responderEntrega(res, {
          invoiceId: String(body.invoiceId ?? ""),
          chave: body.chave ? String(body.chave) : null,
          mlUserId: body.mlUserId ? String(body.mlUserId) : undefined,
          diagnosticoId: body.diagnosticoId ? String(body.diagnosticoId) : undefined,
        });
      } else {
        logPasso(`Rechecar entrega no Nerus (invoice ${url.searchParams.get("invoiceId") ?? ""})`);
        await responderEntrega(res, {
          invoiceId: url.searchParams.get("invoiceId") ?? "",
          chave: url.searchParams.get("chave"),
          mlUserId: url.searchParams.get("mlUserId") || undefined,
          diagnosticoId: url.searchParams.get("diagnosticoId") || undefined,
        });
      }
      return;
    }

    if (url.pathname === "/historico" && req.method === "GET") {
      if (!checarAuth(req, res, config, url)) {
        return;
      }
      if (!bancoConfigurado()) {
        json(res, 503, { ok: false, erro: "histórico desativado — defina MONITOR_DB_HOST" });
        return;
      }
      const dias = Number(url.searchParams.get("dias") ?? 7);
      if (!Number.isFinite(dias) || dias <= 0) {
        json(res, 400, { ok: false, erro: "dias deve ser um número maior que zero" });
        return;
      }
      try {
        logPasso(`Resumir histórico dos últimos ${Math.floor(dias)} dia(s)`);
        json(res, 200, { ok: true, ...(await consultarHistorico(dias)) });
      } catch (erro) {
        console.error(`▶ Histórico falhou: ${msgErro(erro)}`);
        json(res, 500, { ok: false, erro: msgErro(erro) });
      }
      return;
    }

    json(res, 404, {
      ok: false,
      erro:
        "use GET /health, POST /executar, GET /ml/me, GET /ml/invoice, GET /ml/teto, POST /diagnostico, POST /diagnostico/entrega ou GET /historico",
    });
  });

  server.listen(porta, host, () => {
    console.log(`▶ monitor-sftp pronto :${porta}`);
  });
  return server;
}
