// Login do painel: contas por pessoa (PAINEL_USUARIOS), senha em scrypt, sessão em cookie assinado (HMAC).
// Sem dependências e sem estado em disco. Nada secreto vai na URL nem fica acessível ao JS do navegador.
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

export type Papel = "leitura" | "operacao";
export type Conta = { usuario: string; papel: Papel; salt: Buffer; hash: Buffer };
export type Sessao = { usuario: string; papel: Papel };

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const TAM_HASH = 32;
export const DURACAO_SESSAO_MS = 12 * 60 * 60_000;
export const COOKIE = "monitor_sessao";

function scrypt(senha: string, salt: Buffer): Promise<Buffer> {
  // assíncrono de propósito: scryptSync travaria o processo (agenda, /health) durante cada login
  return new Promise((ok, falha) =>
    scryptCb(senha, salt, TAM_HASH, SCRYPT, (erro, chave) => (erro ? falha(erro) : ok(chave))),
  );
}

const USUARIO_VALIDO = /^[a-z0-9._-]{1,64}$/;

/** Linha para PAINEL_USUARIOS. Só hex e ":" — sem "$", que o docker compose interpolaria no .env. */
export async function gerarLinhaConta(usuario: string, papel: Papel, senha: string): Promise<string> {
  if (!USUARIO_VALIDO.test(usuario)) throw new Error("usuário: só letras minúsculas, números, ponto, hífen ou _ (até 64)");
  if (senha.length < 12) throw new Error("senha: mínimo de 12 caracteres");
  const salt = randomBytes(16);
  return `${usuario}:${papel}:${salt.toString("hex")}:${(await scrypt(senha, salt)).toString("hex")}`;
}

/** PAINEL_USUARIOS = "usuario:papel:salt_hex:hash_hex" separados por vírgula, ponto e vírgula ou espaço. Inválida = ignorada (com log). */
export function lerContas(raw = process.env.PAINEL_USUARIOS): Map<string, Conta> {
  const contas = new Map<string, Conta>();
  for (const item of (raw ?? "").split(/[\s,;]+/).filter(Boolean)) {
    const [usuario, papel, salt, hash, ...resto] = item.split(":");
    const ok =
      !resto.length &&
      USUARIO_VALIDO.test(usuario ?? "") &&
      (papel === "leitura" || papel === "operacao") &&
      /^[0-9a-f]{32}$/.test(salt ?? "") &&
      /^[0-9a-f]{64}$/.test(hash ?? "");
    if (!ok) {
      console.error(`▶ PAINEL_USUARIOS: entrada ignorada (formato inválido): ${String(usuario ?? "").slice(0, 64)}`);
      continue;
    }
    contas.set(usuario, { usuario, papel: papel as Papel, salt: Buffer.from(salt, "hex"), hash: Buffer.from(hash, "hex") });
  }
  return contas;
}

const SALT_FALSO = randomBytes(16);
const HASH_FALSO = randomBytes(TAM_HASH);

/** Confere a senha. Usuário inexistente também calcula um scrypt (mesmo tempo): não revela quais contas existem. */
export async function conferirSenha(contas: Map<string, Conta>, usuario: string, senha: string): Promise<Conta | null> {
  const conta = contas.get(usuario);
  const calculado = await scrypt(senha, conta?.salt ?? SALT_FALSO);
  const ok = timingSafeEqual(calculado, conta?.hash ?? HASH_FALSO);
  return ok && conta ? conta : null;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
// impressão da senha atual: trocar a senha de alguém invalida as sessões abertas dessa pessoa
const impressao = (c: Conta) => createHash("sha256").update(c.hash).digest("base64url").slice(0, 16);
const assinar = (dados: string, segredo: string) => createHmac("sha256", segredo).update(dados).digest();

export function criarSessao(conta: Conta, segredo: string, agora = Date.now(), duracao = DURACAO_SESSAO_MS): string {
  const dados = b64(JSON.stringify({ u: conta.usuario, exp: agora + duracao, fp: impressao(conta) }));
  return `${dados}.${b64(assinar(dados, segredo))}`;
}

/** Valida assinatura, validade, conta ainda existente e senha não trocada. O papel vem sempre da conta atual. */
export function lerSessao(token: string, contas: Map<string, Conta>, segredo: string, agora = Date.now()): Sessao | null {
  const [dados, assinatura, ...resto] = token.split(".");
  if (!dados || !assinatura || resto.length) return null;
  const esperado = assinar(dados, segredo);
  const recebido = Buffer.from(assinatura, "base64url");
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return null;
  let p: { u?: unknown; exp?: unknown; fp?: unknown };
  try {
    p = JSON.parse(Buffer.from(dados, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof p.u !== "string" || typeof p.exp !== "number" || p.exp <= agora) return null;
  const conta = contas.get(p.u);
  if (!conta || p.fp !== impressao(conta)) return null;
  return { usuario: conta.usuario, papel: conta.papel };
}

export function lerCookie(header: string | undefined, nome = COOKIE): string | null {
  for (const parte of (header ?? "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim() || null;
  }
  return null;
}

export function cookieSessao(token: string, duracao = DURACAO_SESSAO_MS): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(duracao / 1000)}`;
}

export const COOKIE_SAIR = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// ---- limite de tentativas (em memória: zera num restart; aceito, é só contra força bruta) ----
const JANELA_MS = 15 * 60_000;
export const LIMITE_POR_IP = 20;
export const LIMITE_POR_USUARIO_IP = 5;
export const LIMITE_GLOBAL_POR_MIN = 100;
const falhas = new Map<string, { n: number; desde: number }>();
let global = { n: 0, desde: 0 };

/** IPv6 agrupado por /64 (quem tem um /64 troca de IP à vontade); IPv4 inteiro. */
export function chaveIp(ip: string): string {
  const v = ip.replace(/^::ffff:/, "");
  if (!v.includes(":")) return v;
  const blocos = v.split("::")[0].split(":").slice(0, 4);
  return blocos.join(":") + "::/64";
}

function contagem(chave: string, agora: number): number {
  const f = falhas.get(chave);
  if (!f || agora - f.desde >= JANELA_MS) return 0;
  return f.n;
}

function somar(chave: string, agora: number): void {
  const n = contagem(chave, agora);
  falhas.set(chave, { n: n + 1, desde: n ? falhas.get(chave)!.desde : agora });
}

/**
 * Reserva uma tentativa ANTES do scrypt (conta como falha até o sucesso limpar): N requisições em paralelo
 * não passam juntas pelo limite. Retorna false se o limite (usuário+IP, IP, ou global) já estourou.
 */
export function reservarTentativa(ip: string, usuario: string, agora = Date.now()): boolean {
  if (falhas.size > 10_000) for (const [k, f] of falhas) if (agora - f.desde >= JANELA_MS) falhas.delete(k);
  if (agora - global.desde >= 60_000) global = { n: 0, desde: agora };
  const kip = `ip:${chaveIp(ip)}`;
  const kus = `u:${usuario}|${chaveIp(ip)}`;
  if (global.n >= LIMITE_GLOBAL_POR_MIN || contagem(kip, agora) >= LIMITE_POR_IP || contagem(kus, agora) >= LIMITE_POR_USUARIO_IP) return false;
  global.n++;
  somar(kip, agora);
  somar(kus, agora);
  return true;
}

/** Login certo: devolve a tentativa reservada (não conta como falha). */
export function liberarTentativa(ip: string, usuario: string, agora = Date.now()): void {
  for (const chave of [`ip:${chaveIp(ip)}`, `u:${usuario}|${chaveIp(ip)}`]) {
    const f = falhas.get(chave);
    if (f && agora - f.desde < JANELA_MS) {
      if (f.n <= 1) falhas.delete(chave);
      else f.n--;
    }
  }
  global.n = Math.max(0, global.n - 1);
}

/** Bearer errado também conta (por IP): token da API não pode ser descoberto por tentativa e erro. */
export function bearerBloqueado(ip: string, agora = Date.now()): boolean {
  return contagem(`b:${chaveIp(ip)}`, agora) >= LIMITE_POR_IP;
}
export function registrarFalhaBearer(ip: string, agora = Date.now()): void {
  somar(`b:${chaveIp(ip)}`, agora);
}

// No máximo 3 scrypt ao mesmo tempo: uma rajada de logins não toma a CPU da agenda e do /health.
const MAX_SCRYPT = 3;
let scryptEmCurso = 0;
export async function comVagaScrypt<T>(fn: () => Promise<T>): Promise<T | "ocupado"> {
  if (scryptEmCurso >= MAX_SCRYPT) return "ocupado";
  scryptEmCurso++;
  try {
    return await fn();
  } finally {
    scryptEmCurso--;
  }
}

/** Usuário só vai para o log se tiver o formato de usuário (senão pode ser uma senha digitada no campo errado). */
export function usuarioParaLog(u: string): string {
  return USUARIO_VALIDO.test(u) ? u : "?";
}

/** Só para testes. */
export function _zerarLimites(): void {
  falhas.clear();
  global = { n: 0, desde: 0 };
}
