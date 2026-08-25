import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AppConfig } from "./types.js";
import { executarJob, jobOcupado } from "./job.js";
import { localizarInvoicePorNf, listarNotasAutorizadas, tetosPorSerie, validarUsuarioMl } from "./ml-invoices.js";
import { consultarEstadoNerus, diagnosticarNota, classificarEntregas } from "./diagnostico.js";

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

async function responderEntrega(
  res: ServerResponse,
  params: { invoiceId: string; chave?: string | null; mlUserId?: string },
): Promise<void> {
  const invoiceId = String(params.invoiceId ?? "").trim();
  const chave = params.chave ? String(params.chave) : null;
  const mlUserId = params.mlUserId || process.env.ML_USER_ID || "";
  const tenantId = process.env.NERUS_TENANT_ID || "";
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
    json(res, 200, {
      ok: true,
      notificacaoRecebida: Boolean(estado.notificacao),
      invoice: estado.invoice,
      entregas: estado.entregas,
      entregaEnviada: entrega === "enviada",
      classificacaoEntrega: entrega,
    });
  } catch (erro) {
    console.error(`▶ Entrega Nerus falhou: ${msgErro(erro)}`);
    json(res, 500, {
      ok: false,
      erro: msgErro(erro),
    });
  }
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

    if (url.pathname === "/executar" && (req.method === "POST" || req.method === "GET")) {
      if (!autorizado(req, tokenMonitor(config), url)) {
        json(res, 401, { ok: false, erro: "token inválido" });
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
      if (!autorizado(req, tokenMonitor(config), url)) {
        json(res, 401, { ok: false, erro: "token inválido" });
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
      if (!autorizado(req, tokenMonitor(config), url)) {
        json(res, 401, { ok: false, erro: "token inválido" });
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

    if (url.pathname === "/diagnostico" && req.method === "POST") {
      if (!autorizado(req, tokenMonitor(config), url)) {
        json(res, 401, { ok: false, erro: "token inválido" });
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
        json(res, 200, { ok: true, ...relatorio });
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
      if (!autorizado(req, tokenMonitor(config), url)) {
        json(res, 401, { ok: false, erro: "token inválido" });
        return;
      }
      if (req.method === "POST") {
        const body = await lerJson(req);
        logPasso(`Rechecar entrega no Nerus (invoice ${String(body.invoiceId ?? "")})`);
        await responderEntrega(res, {
          invoiceId: String(body.invoiceId ?? ""),
          chave: body.chave ? String(body.chave) : null,
          mlUserId: body.mlUserId ? String(body.mlUserId) : undefined,
        });
      } else {
        logPasso(`Rechecar entrega no Nerus (invoice ${url.searchParams.get("invoiceId") ?? ""})`);
        await responderEntrega(res, {
          invoiceId: url.searchParams.get("invoiceId") ?? "",
          chave: url.searchParams.get("chave"),
          mlUserId: url.searchParams.get("mlUserId") || undefined,
        });
      }
      return;
    }

    json(res, 404, {
      ok: false,
      erro:
        "use GET /health, POST /executar, GET /ml/me, GET /ml/invoice, GET /ml/teto, POST /diagnostico ou POST /diagnostico/entrega",
    });
  });

  server.listen(porta, host, () => {
    console.log(`▶ monitor-sftp pronto :${porta}`);
  });
}
