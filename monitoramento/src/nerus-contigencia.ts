import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function reqEnv(nome: string): string {
  const v = process.env[nome]?.trim();
  if (!v) throw new Error(`Defina ${nome} no .env`);
  return v;
}

function extrairToken(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  for (const chave of ["token", "accessToken", "access_token", "idToken", "jwt"]) {
    const v = obj[chave];
    if (typeof v === "string" && v.length > 20) return v;
  }
  const auth = obj.AuthenticationResult;
  if (auth && typeof auth === "object") {
    const inner = auth as Record<string, unknown>;
    for (const chave of ["IdToken", "AccessToken", "token"]) {
      const v = inner[chave];
      if (typeof v === "string" && v.length > 20) return v;
    }
  }
  const data = obj.data;
  if (data && typeof data === "object") return extrairToken(data);
  return null;
}

export async function autenticarNerus(): Promise<string> {
  const url = reqEnv("NERUS_AUTH_URL");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: reqEnv("NERUS_USERNAME"),
      password: reqEnv("NERUS_PASSWORD"),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new Error(`Auth Nerus HTTP ${res.status}`);
  const token = extrairToken(json);
  if (!token) throw new Error("Auth Nerus não retornou token");
  return token;
}

export async function renotificarInvoice(opts: {
  invoiceId: string;
  mlUserId: string;
  applicationId: string;
}): Promise<{ notificationId: string; httpStatus: number }> {
  const tenant = reqEnv("NERUS_TENANT_ID");
  const base = reqEnv("NERUS_NOTIFICATION_URL");
  const url = `${base}?clientId=${encodeURIComponent(tenant)}`;
  const token = await autenticarNerus();
  const notificationId = randomUUID();
  const agora = new Date().toISOString();
  const payload = {
    _id: notificationId,
    topic: "invoices",
    resource: `/users/${opts.mlUserId}/invoices/${opts.invoiceId}`,
    user_id: Number(opts.mlUserId),
    application_id: Number(opts.applicationId),
    sent: agora,
    attempts: 1,
    received: agora,
    actions: [] as unknown[],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const texto = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Renotificação HTTP ${res.status}: ${texto.slice(0, 240)}`);
  }
  return { notificationId, httpStatus: res.status };
}

export const JANELA_CONTINGENCIA_MS = 30 * 60_000;

// Trava gravada em disco (data/contingencias.json): um restart do monitor dentro da janela não libera
// uma segunda renotificação da mesma invoice. Sem disco, segue só em memória (com log).
const caminhoTrava = () => process.env.CONTINGENCIAS_PATH?.trim() || "data/contingencias.json";
let reenviadas: Map<string, number> | null = null;

function carregar(agora: number): Map<string, number> {
  if (reenviadas) return reenviadas;
  reenviadas = new Map();
  try {
    const dados = JSON.parse(readFileSync(caminhoTrava(), "utf8")) as Record<string, unknown>;
    for (const [inv, ms] of Object.entries(dados)) {
      if (typeof ms === "number" && agora - ms < JANELA_CONTINGENCIA_MS) reenviadas.set(inv, ms);
    }
  } catch {
    /* sem arquivo (primeira vez) ou ilegível: começa vazio */
  }
  return reenviadas;
}

function gravar(mapa: Map<string, number>, agora: number): void {
  for (const [inv, ms] of mapa) if (agora - ms >= JANELA_CONTINGENCIA_MS) mapa.delete(inv); // poda as vencidas
  const arq = caminhoTrava();
  try {
    mkdirSync(dirname(arq), { recursive: true });
    writeFileSync(`${arq}.tmp`, JSON.stringify(Object.fromEntries(mapa)));
    renameSync(`${arq}.tmp`, arq);
  } catch (erro) {
    console.error(`▶ Trava da contingência não gravada (${erro instanceof Error ? erro.message : String(erro)}); vale só até o restart`);
  }
}

/** Reserva a contingência da invoice. Retorna o horário da anterior (ms) se já houve uma na janela; null = pode disparar. */
export function reservarContingencia(invoiceId: string, agora = Date.now()): number | null {
  const mapa = carregar(agora);
  const anterior = mapa.get(invoiceId);
  if (anterior !== undefined && agora - anterior < JANELA_CONTINGENCIA_MS) return anterior;
  mapa.set(invoiceId, agora);
  gravar(mapa, agora);
  return null;
}

/** Libera a reserva quando a renotificação falhou, para o próximo ciclo poder tentar de novo. */
export function liberarContingencia(invoiceId: string): void {
  const mapa = carregar(Date.now());
  mapa.delete(invoiceId);
  gravar(mapa, Date.now());
}

/** Só para testes: esquece o que está em memória, como num restart. */
export function _reiniciarTrava(): void {
  reenviadas = null;
}
