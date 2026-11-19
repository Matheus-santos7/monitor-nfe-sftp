import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./types.js";
import { executarJob, jobOcupado, statusPainel } from "./job.js";
import { diaDe, lerDia, listarDias, resumirDia } from "./historico.js";
import { toleranciaMin } from "./gaps.js";
import { depsOrquestradorReais, dispararCiclo, estadoCiclo, type DepsOrquestrador } from "./orquestrador.js";
import {
  COOKIE_SAIR,
  conferirSenha,
  cookieSessao,
  criarSessao,
  lerContas,
  lerCookie,
  lerSessao,
  bearerBloqueado,
  comVagaScrypt,
  liberarTentativa,
  registrarFalhaBearer,
  reservarTentativa,
  usuarioParaLog,
  type Conta,
  type Papel,
} from "./sessao.js";
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
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
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
export type Permissao = Papel;
export type Acesso = { papel: Papel; usuario: string; via: "bearer" | "sessao" };

/** Bearer = scripts e integrações (API_HOST). Só o token de operação, só por header; sem token configurado, nenhum Bearer vale. */
export function acessoBearer(req: IncomingMessage, token?: string): Acesso | null {
  if (!token) return null;
  const ok = igual(req.headers.authorization, `Bearer ${token}`) || igual(req.headers["x-token"], token);
  return ok ? { papel: "operacao", usuario: "token-api", via: "bearer" } : null;
}

/** Sessão = pessoas no painel (cookie HttpOnly). Sem SESSAO_SEGREDO, nenhuma sessão vale. */
export function acessoSessao(req: IncomingMessage, contas: Map<string, Conta>, segredo?: string): Acesso | null {
  const token = segredo ? lerCookie(req.headers.cookie) : null;
  const s = token && segredo ? lerSessao(token, contas, segredo) : null;
  return s ? { ...s, via: "sessao" } : null;
}

/**
 * CSRF: requisição que muda algo, vinda do navegador (cookie), precisa do header X-Painel: 1 (outro site não
 * consegue mandá-lo sem CORS) e Origin igual ao endereço do painel na config — nunca o Host, que o nginx reescreve.
 */
export function origemDoPainel(req: IncomingMessage, painelHost = process.env.PAINEL_HOST, painelPorta = process.env.PAINEL_PORTA): boolean {
  const host = painelHost?.trim() || "painel.localhost";
  const permitidas = [`https://${host}`];
  // acesso direto pela porta local só em desenvolvimento (PAINEL_HOST *.localhost), nunca em produção
  if (host === "localhost" || host.endsWith(".localhost")) {
    const porta = painelPorta?.trim() || "8080";
    permitidas.push(`http://localhost:${porta}`, `http://127.0.0.1:${porta}`);
  }
  return req.headers["x-painel"] === "1" && typeof req.headers.origin === "string" && permitidas.includes(req.headers.origin);
}

/** IP do cliente: o nginx do painel sobrescreve X-Real-IP com o IP real (vindo do Caddy). Sem ele, o do socket. */
/**
 * Pedido chegou pelo endereço da API (Host = API_HOST)? Por ali só vale Bearer: sem login, sem cookie.
 * O próprio app garante isso, porque na frente pode haver um balanceador (ex.: ALB da AWS) que não filtra nada.
 */
export function viaApiHost(req: IncomingMessage, apiHost = process.env.API_HOST): boolean {
  const host = String(req.headers.host ?? "").split(":")[0].trim().toLowerCase();
  const api = apiHost?.trim().toLowerCase();
  return Boolean(api && host === api);
}

/**
 * IP do cliente.
 * - Pelo painel: o nginx do painel sobrescreve X-Real-IP com o IP real.
 * - Pelo API_HOST (sem nginx no caminho): a ÚLTIMA entrada do X-Forwarded-For, que é a que o balanceador
 *   escreveu; as anteriores e o X-Real-IP vêm do cliente e podem ser forjados.
 */
export function ipCliente(req: IncomingMessage, apiHost = process.env.API_HOST): string {
  if (viaApiHost(req, apiHost)) {
    const xff = req.headers["x-forwarded-for"];
    const ultimo = typeof xff === "string" ? xff.split(",").pop()?.trim() : "";
    return ultimo || req.socket.remoteAddress || "?";
  }
  const real = req.headers["x-real-ip"];
  return (typeof real === "string" && real.trim()) || req.socket.remoteAddress || "?";
}

type Auth = { contas: Map<string, Conta>; segredo?: string; token?: string };

/** Responde 401/403 e devolve null se o acesso não alcança o nível pedido. `muda` = rota que altera estado (CSRF). */
function exigir(req: IncomingMessage, res: ServerResponse, auth: Auth, nivel: Papel, muda = false): Acesso | null {
  const tentouBearer = Boolean(req.headers.authorization || req.headers["x-token"]);
  const ip = ipCliente(req);
  if (tentouBearer && bearerBloqueado(ip)) {
    json(res, 429, { ok: false, erro: "muitas tentativas; tente de novo em 15 minutos" });
    return null;
  }
  const bearer = acessoBearer(req, auth.token);
  if (tentouBearer && !bearer) {
    registrarFalhaBearer(ip);
    console.warn(`▶ Bearer inválido: ip=${ip} rota=${req.url?.split("?")[0]}`);
  }
  // pelo endereço da API, sessão (cookie) não vale: só Bearer
  const acesso = bearer ?? (viaApiHost(req) ? null : acessoSessao(req, auth.contas, auth.segredo));
  if (!acesso) {
    json(res, 401, { ok: false, erro: "não autenticado: entre pelo painel ou use Authorization: Bearer" });
    return null;
  }
  if (muda && acesso.via === "sessao" && !origemDoPainel(req)) {
    json(res, 403, { ok: false, erro: "origem não permitida" });
    return null;
  }
  if (nivel === "operacao" && acesso.papel !== "operacao") {
    json(res, 403, { ok: false, erro: "esta conta é só de leitura" });
    return null;
  }
  return acesso;
}

const LIMITE_LOGIN_BYTES = 4096;

/** Corpo JSON pequeno (login). Acima do limite, para de ler e devolve null. */
async function lerJsonPequeno(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const partes: Buffer[] = [];
  let tamanho = 0;
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    tamanho += b.length;
    if (tamanho > LIMITE_LOGIN_BYTES) return null;
    partes.push(b);
  }
  try {
    const v = JSON.parse(Buffer.concat(partes).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function lerAuth(config: AppConfig): Auth {
  const segredo = process.env.SESSAO_SEGREDO?.trim() ?? "";
  const contas = lerContas();
  if (segredo.length < 32) console.warn("▶ ATENÇÃO: SESSAO_SEGREDO ausente ou curto (mín. 32): login do painel DESLIGADO");
  else if (!contas.size) console.warn("▶ ATENÇÃO: PAINEL_USUARIOS vazio: ninguém consegue entrar no painel");
  else console.log(`▶ Painel: ${contas.size} conta(s) (${[...contas.values()].map((c) => `${c.usuario}/${c.papel}`).join(", ")})`);
  const token = tokenMonitor(config);
  if (token && token.length < 32) console.warn("▶ ATENÇÃO: MONITOR_HTTP_TOKEN curto (mín. 32): Bearer da API DESLIGADO");
  return { contas, segredo: segredo.length >= 32 ? segredo : undefined, token: token && token.length >= 32 ? token : undefined };
}

export function intervaloPainelMin(): number {
  const v = Number(process.env.PAINEL_INTERVALO_MIN ?? 5);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function iniciarHttp(config: AppConfig): void {
  const porta = Number(process.env.PORT ?? config.http?.porta ?? 8080);
  const host = "0.0.0.0";

  const auth = lerAuth(config);
  const server = createServer((req, res) => {
    // Nenhum erro de rota pode virar unhandled rejection (derrubaria o processo e o painel).
    rotear(config, auth, req, res).catch((erro) => {
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

async function rotear(config: AppConfig, auth: Auth, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // Login e sessão só pelo painel. Pelo API_HOST, as rotas de sessão não existem.
  if (viaApiHost(req) && ["/login", "/logout", "/sessao"].includes(url.pathname)) {
    json(res, 404, { ok: false, erro: "não encontrado" });
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    json(res, 200, { ok: true, ocupado: jobOcupado() });
    return;
  }

  if (url.pathname === "/login" && req.method === "POST") {
    if (!origemDoPainel(req)) {
      json(res, 403, { ok: false, erro: "origem não permitida" });
      return;
    }
    if (!auth.segredo) {
      json(res, 503, { ok: false, erro: "login desligado: defina SESSAO_SEGREDO no .env" });
      return;
    }
    const corpo = await lerJsonPequeno(req);
    const usuario = typeof corpo?.usuario === "string" ? corpo.usuario.trim().toLowerCase().slice(0, 64) : "";
    const senha = typeof corpo?.senha === "string" ? corpo.senha.slice(0, 256) : "";
    if (!usuario || !senha) {
      json(res, 400, { ok: false, erro: "informe usuário e senha" });
      return;
    }
    const ip = ipCliente(req);
    const quem = usuarioParaLog(usuario);
    if (!reservarTentativa(ip, usuario)) {
      console.warn(`▶ Login bloqueado por excesso de tentativas: usuario=${quem} ip=${ip}`);
      json(res, 429, { ok: false, erro: "muitas tentativas; tente de novo em 15 minutos" });
      return;
    }
    const conta = await comVagaScrypt(() => conferirSenha(auth.contas, usuario, senha));
    if (conta === "ocupado") {
      liberarTentativa(ip, usuario); // não foi culpa de quem tentou
      json(res, 503, { ok: false, erro: "muitos logins ao mesmo tempo; tente de novo em instantes" });
      return;
    }
    if (!conta) {
      console.warn(`▶ Login falhou: usuario=${quem} ip=${ip}`);
      json(res, 401, { ok: false, erro: "usuário ou senha inválidos" });
      return;
    }
    liberarTentativa(ip, usuario);
    console.log(`▶ Login: ${conta.usuario} (${conta.papel}) ip=${ip}`);
    res.setHeader("Set-Cookie", cookieSessao(criarSessao(conta, auth.segredo)));
    json(res, 200, { ok: true, usuario: conta.usuario, papel: conta.papel });
    return;
  }

  if (url.pathname === "/logout" && req.method === "POST") {
    if (!origemDoPainel(req)) {
      json(res, 403, { ok: false, erro: "origem não permitida" });
      return;
    }
    res.setHeader("Set-Cookie", COOKIE_SAIR);
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/sessao" && req.method === "GET") {
    const s = acessoSessao(req, auth.contas, auth.segredo);
    json(res, s ? 200 : 401, s ? { ok: true, usuario: s.usuario, papel: s.papel } : { ok: false, login: Boolean(auth.segredo) });
    return;
  }

  if (url.pathname === "/status" && req.method === "GET") {
    const acesso = exigir(req, res, auth, "leitura");
    if (!acesso) return;
    json(res, 200, {
      ok: true,
      ocupado: jobOcupado(),
      intervaloMin: intervaloPainelMin(),
      toleranciaMin: toleranciaMin(),
      cliente: config.cliente,
      permissao: acesso.papel,
      usuario: acesso.usuario,
      ciclo: estadoCiclo(),
      ...statusPainel(),
    });
    return;
  }

  if (url.pathname === "/historico" && req.method === "GET") {
    if (!exigir(req, res, auth, "leitura")) return;
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
    const acesso = exigir(req, res, auth, "operacao", true);
    if (!acesso) return;
    const { modo } = estadoCiclo();
    if (modo === "off") {
      json(res, 409, { ok: false, erro: "agenda desligada (MODO_AGENDA=off): o monitor está pausado" });
      return;
    }
    depsManual ??= depsOrquestradorReais(config);
    const iniciado = dispararCiclo(depsManual, { origem: "manual", sombra: modo === "sombra", quem: acesso.usuario });
    console.log(`▶ Executar agora por ${acesso.usuario} (${acesso.via}, ${ipCliente(req)}): ${iniciado ? "iniciado" : "recusado, já em andamento"}`);
    json(res, iniciado ? 202 : 409, iniciado ? { ok: true, ciclo: estadoCiclo() } : { ok: false, erro: "já há um ciclo em andamento" });
    return;
  }

  if (url.pathname === "/ml/teto" && req.method === "GET") {
    if (!exigir(req, res, auth, "operacao")) return;
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
      "use GET /health, GET /status, GET /historico, POST /ciclo/agora, GET /ml/teto, POST /login, POST /logout ou GET /sessao",
  });
}
