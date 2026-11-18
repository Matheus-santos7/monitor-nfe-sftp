// Envio dos avisos (Google Chat, e-mail, WhatsApp) — antes nos nós "Avisar …" do n8n.
// Cada canal é independente: um que falha não impede os outros. Canal sem variável no .env é pulado.
import nodemailer from "nodemailer";
import type { Mensagem } from "./relatorio.js";

export type Canal = { nome: string; enviar: (m: Mensagem) => Promise<void> };
export type ResultadoEnvio = { entregues: string[]; falhas: { canal: string; erro: string }[] };

type Env = Record<string, string | undefined>;
type Transporte = { sendMail: (m: { from: string; to: string; subject: string; text: string }) => Promise<unknown> };
type DepsCanais = { fetch: typeof fetch; criarTransporte: (opcoes: Record<string, unknown>) => Transporte };

const TIMEOUT_MS = 20_000;
const v = (env: Env, nome: string) => env[nome]?.trim() || "";

async function postJson(f: typeof fetch, url: string, corpo: unknown): Promise<void> {
  const res = await f(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

const depsReais: DepsCanais = {
  fetch: (...a) => globalThis.fetch(...a),
  criarTransporte: (o) => nodemailer.createTransport(o),
};

/** Canais configurados no ambiente, no mesmo formato que o n8n enviava. */
export function canaisDoAmbiente(env: Env = process.env, deps: DepsCanais = depsReais): Canal[] {
  const canais: Canal[] = [];

  const chat = v(env, "GOOGLE_CHAT_WEBHOOK_URL");
  if (chat) canais.push({ nome: "Google Chat", enviar: (m) => postJson(deps.fetch, chat, { text: m.mensagem }) });

  const zap = v(env, "WHATSAPP_WEBHOOK_URL");
  if (zap) {
    canais.push({ nome: "WhatsApp", enviar: (m) => postJson(deps.fetch, zap, { number: v(env, "WHATSAPP_TO"), text: m.mensagem }) });
  }

  const host = v(env, "SMTP_HOST");
  const para = v(env, "ALERT_EMAIL_TO");
  if (host && para) {
    const porta = Number(v(env, "SMTP_PORT") || 587);
    const transporte = deps.criarTransporte({
      host,
      port: porta,
      secure: /^(1|true|on|sim)$/i.test(v(env, "SMTP_SECURE")) || porta === 465,
      auth: v(env, "SMTP_USER") ? { user: v(env, "SMTP_USER"), pass: v(env, "SMTP_PASS") } : undefined,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
    });
    canais.push({
      nome: "e-mail",
      enviar: async (m) => {
        await transporte.sendMail({ from: v(env, "ALERT_EMAIL_FROM") || para, to: para, subject: m.assunto, text: m.mensagem });
      },
    });
  }
  return canais;
}

/** Envia em todos os canais, em paralelo; nunca lança. Quem chama decide o que fazer se nenhum entregou. */
export async function enviarAviso(m: Mensagem, canais: Canal[]): Promise<ResultadoEnvio> {
  const resultados = await Promise.allSettled(canais.map((c) => c.enviar(m)));
  const r: ResultadoEnvio = { entregues: [], falhas: [] };
  resultados.forEach((s, i) => {
    if (s.status === "fulfilled") r.entregues.push(canais[i].nome);
    else {
      const erro = s.reason instanceof Error ? s.reason.message : String(s.reason);
      r.falhas.push({ canal: canais[i].nome, erro });
      console.error(`▶ Aviso não entregue em ${canais[i].nome}: ${erro}`);
    }
  });
  return r;
}
