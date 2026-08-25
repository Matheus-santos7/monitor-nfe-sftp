import { accessTokenMl } from "./ml-auth.js";
import { partesDaChave } from "./chave.js";

const API = "https://api.mercadolibre.com";
const PADRAO_NFE = /(\d+)_(\d{44})(?:-procNFe)?\.xml$/i;
const cacheZip = new Map<string, { nomes: string[]; exp: number }>();
const CACHE_MS = 5 * 60 * 1000;

export type InvoiceRelatorio = {
  invoiceId: string;
  chave: string;
  numero: number;
  serie: number;
  xmlNome: string;
};

export type InvoiceLocalizada = InvoiceRelatorio & {
  encontrado: true;
  periodo: { start: string; end: string; fonte: string };
};

async function tokenMl(forcar = false): Promise<string> {
  return accessTokenMl({ forcar });
}

export function yyyymmddEmTz(date = new Date(), tz = process.env.TZ || "America/Sao_Paulo"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}${pick("month")}${pick("day")}`;
}

export function somarDiasYyyymmdd(yyyymmdd: string, dias: number, tz = process.env.TZ || "America/Sao_Paulo"): string {
  const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T12:00:00`;
  const base = new Date(`${iso}-03:00`);
  return yyyymmddEmTz(new Date(base.getTime() + dias * 86_400_000), tz);
}

/** Nome no ZIP do relatório: {invoice_id}_{chave44}-procNFe.xml */
export function parseNomeRelatorio(nome: string): InvoiceRelatorio | null {
  const base = nome.split("/").pop() ?? nome;
  const match = PADRAO_NFE.exec(base);
  if (!match) return null;
  const chave = match[2];
  const partes = partesDaChave(chave);
  return {
    invoiceId: match[1],
    chave,
    numero: partes.numero,
    serie: partes.serie,
    xmlNome: nome,
  };
}

export function listarNomesZip(buf: Buffer): string[] {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65_535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP inválido: diretório central não encontrado");
  const entries = buf.readUInt16LE(eocd + 10);
  if (entries === 0xffff) throw new Error("ZIP64 não suportado no relatório de NF-e");
  let p = buf.readUInt32LE(eocd + 16);
  const nomes: string[] = [];
  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP inválido: entrada do diretório");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    nomes.push(buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return nomes;
}

async function mlGetBuffer(path: string): Promise<Buffer> {
  let lastMsg = "";
  let token = await tokenMl();
  for (let tentativa = 1; tentativa <= 5; tentativa++) {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
      signal: AbortSignal.timeout(120_000),
    });
    const raw = Buffer.from(await res.arrayBuffer());
    if (res.ok) return raw;
    lastMsg = raw.subarray(0, 400).toString("utf8");
    if (res.status === 401 && tentativa === 1) {
      token = await tokenMl(true);
      continue;
    }
    if (res.status !== 429 || tentativa === 5) {
      throw new Error(`Mercado Livre ${res.status} em ${path}: ${lastMsg}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const esperaMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * tentativa * tentativa;
    console.warn(`Relatório ML 429 — nova tentativa ${tentativa + 1}/5 em ${esperaMs}ms`);
    await new Promise((r) => setTimeout(r, esperaMs));
  }
  throw new Error(`Mercado Livre 429 em ${path}: ${lastMsg}`);
}

export async function validarUsuarioMl(): Promise<{ id: number }> {
  let token = await tokenMl();
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const res = await fetch(`${API}/users/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 && tentativa === 1) {
      token = await tokenMl(true);
      continue;
    }
    if (!res.ok) throw new Error(`GET /users/me falhou: ${res.status}`);
    const body = (await res.json()) as { id?: number };
    if (!body.id) throw new Error("GET /users/me não retornou id");
    return { id: body.id };
  }
  throw new Error("GET /users/me falhou: 401");
}

async function userId(): Promise<number> {
  const cached = process.env.ML_USER_ID?.trim();
  if (cached) return Number(cached);
  const me = await validarUsuarioMl();
  return me.id;
}

async function nomesDoRelatorio(fonte: string, path: string): Promise<string[]> {
  const hit = cacheZip.get(fonte);
  if (hit && hit.exp > Date.now()) return hit.nomes;
  const buf = await mlGetBuffer(path);
  const nomes = listarNomesZip(buf);
  cacheZip.set(fonte, { nomes, exp: Date.now() + CACHE_MS });
  return nomes;
}

export function tetosPorSerie(notas: InvoiceRelatorio[]): Map<number, InvoiceRelatorio> {
  const tetos = new Map<number, InvoiceRelatorio>();
  for (const nota of notas) {
    const atual = tetos.get(nota.serie);
    if (!atual || nota.numero > atual.numero) tetos.set(nota.serie, nota);
  }
  return tetos;
}

function qsRelatorioAutorizado(): URLSearchParams {
  return new URLSearchParams({
    sale: "authorized",
    return: "all",
    full: "all",
    others: "all",
    file_types: "xml",
    simple_folder: "true",
  });
}

async function nomesJanela(uid: number, start: string, end: string): Promise<string[]> {
  const qs = qsRelatorioAutorizado();
  qs.set("start", start);
  qs.set("end", end);
  return nomesDoRelatorio(
    `stream:${start}:${end}`,
    `/users/${uid}/invoices/sites/MLB/batch_request/period/stream?${qs}`,
  );
}

export async function listarNotasAutorizadas(opts?: {
  start?: string;
  end?: string;
}): Promise<{ start: string; end: string; notas: InvoiceRelatorio[] }> {
  const uid = await userId();
  const hoje = yyyymmddEmTz();
  const dias = Math.max(1, Number(process.env.ML_TETO_DIAS ?? 1) || 1);
  const end = opts?.end ?? hoje;
  const start = opts?.start ?? somarDiasYyyymmdd(end, -(dias - 1));
  const nomes = await nomesJanela(uid, start, end);
  const notas: InvoiceRelatorio[] = [];
  for (const nome of nomes) {
    const parsed = parseNomeRelatorio(nome);
    if (parsed) notas.push(parsed);
  }
  return { start, end, notas };
}

export async function buscarTetosPorSerie(series: number[]): Promise<{
  start: string;
  end: string;
  tetos: Map<number, InvoiceRelatorio>;
}> {
  const desejadas = new Set(series);
  const { start, end, notas } = await listarNotasAutorizadas();
  const tetos = tetosPorSerie(notas.filter((n) => desejadas.has(n.serie)));
  return { start, end, tetos };
}

function acharNosNomes(nomes: string[], numero: number, serie: number): InvoiceRelatorio | null {
  for (const nome of nomes) {
    const parsed = parseNomeRelatorio(nome);
    if (parsed && parsed.numero === numero && parsed.serie === serie) return parsed;
  }
  return null;
}

async function buscarJanela(
  uid: number,
  numero: number,
  serie: number,
  start: string,
  end: string,
): Promise<InvoiceLocalizada | null> {
  const nomes = await nomesJanela(uid, start, end);
  const hit = acharNosNomes(nomes, numero, serie);
  if (!hit) return null;
  return { ...hit, encontrado: true, periodo: { start, end, fonte: `stream:${start}:${end}` } };
}

async function buscarMes(
  uid: number,
  numero: number,
  serie: number,
  yyyymm: string,
): Promise<InvoiceLocalizada | null> {
  const fonte = `mes:${yyyymm}`;
  const nomes = await nomesDoRelatorio(
    fonte,
    `/users/${uid}/invoices/sites/MLB/batch_request/period/${yyyymm}`,
  );
  const hit = acharNosNomes(nomes, numero, serie);
  if (!hit) return null;
  const start = `${yyyymm}01`;
  return { ...hit, encontrado: true, periodo: { start, end: start, fonte } };
}

export async function localizarInvoicePorNf(opts: {
  numero: number;
  serie: number;
  start?: string;
  end?: string;
}): Promise<InvoiceLocalizada | { encontrado: false; numero: number; serie: number; tentativas: string[] }> {
  const numero = opts.numero;
  const serie = opts.serie;
  const uid = await userId();
  const tentativas: string[] = [];
  const hoje = yyyymmddEmTz();

  const janelas: Array<{ start: string; end: string } | { mes: string }> = [];
  if (opts.start && opts.end) {
    janelas.push({ start: opts.start, end: opts.end });
  } else {
    janelas.push({ start: hoje, end: hoje });
    janelas.push({ start: somarDiasYyyymmdd(hoje, -6), end: hoje });
    janelas.push({ mes: hoje.slice(0, 6) });
  }

  for (const janela of janelas) {
    if ("mes" in janela) {
      tentativas.push(janela.mes);
      const hit = await buscarMes(uid, numero, serie, janela.mes);
      if (hit) return hit;
      continue;
    }
    tentativas.push(`${janela.start}-${janela.end}`);
    const hit = await buscarJanela(uid, numero, serie, janela.start, janela.end);
    if (hit) return hit;
  }

  return { encontrado: false, numero, serie, tentativas };
}
