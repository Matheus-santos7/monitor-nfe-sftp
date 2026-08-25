import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const OAUTH = "https://api.mercadolibre.com/oauth/token";
const MARGEM_MS = 5 * 60 * 1000;

export type TokensMl = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

type OauthResposta = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user_id?: number;
  error?: string;
  message?: string;
  error_description?: string;
};

let memoria: TokensMl | null = null;
let renovacao: Promise<string> | null = null;

export function resetMlAuthForTests(): void {
  memoria = null;
  renovacao = null;
}

export function credenciaisRefreshMl(): boolean {
  return Boolean(
    process.env.ML_CLIENT_ID?.trim() &&
      process.env.ML_CLIENT_SECRET?.trim() &&
      (memoria?.refreshToken || process.env.ML_REFRESH_TOKEN?.trim()),
  );
}

export function credenciaisMlConfiguradas(): boolean {
  hidratarMemoria();
  return Boolean(memoria?.accessToken) || credenciaisRefreshMl();
}

function caminhoTokens(): string {
  return process.env.ML_TOKENS_PATH?.trim() || "/app/data/ml-tokens.json";
}

function caminhoEnv(): string | undefined {
  const p = process.env.ML_ENV_PATH?.trim();
  return p || undefined;
}

export function upsertLinhaEnv(texto: string, chave: string, valor: string): string {
  const linha = `${chave}=${valor}`;
  const re = new RegExp(`^${chave}=.*$`, "m");
  if (re.test(texto)) return texto.replace(re, linha);
  return `${texto.replace(/\s*$/, "")}\n${linha}\n`;
}

function lerArquivoTokens(): TokensMl | null {
  try {
    const raw = readFileSync(caminhoTokens(), "utf8");
    const json = JSON.parse(raw) as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
    };
    if (!json.access_token || !json.refresh_token) return null;
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Number(json.expires_at) || 0,
    };
  } catch {
    return null;
  }
}

function hidratarMemoria(): void {
  if (memoria) return;
  memoria = lerArquivoTokens();
  if (memoria) {
    process.env.ML_ACCESS_TOKEN = memoria.accessToken;
    process.env.ML_REFRESH_TOKEN = memoria.refreshToken;
    return;
  }
  const access = process.env.ML_ACCESS_TOKEN?.trim() || "";
  const refresh = process.env.ML_REFRESH_TOKEN?.trim() || "";
  if (access || refresh) {
    memoria = {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: 0,
    };
  }
}

function tokenAindaValido(t: TokensMl | null): boolean {
  if (!t?.accessToken) return false;
  if (!t.expiresAt) return false;
  return t.expiresAt - MARGEM_MS > Date.now();
}

function persistir(tokens: TokensMl): void {
  const arquivo = caminhoTokens();
  mkdirSync(dirname(arquivo), { recursive: true });
  writeFileSync(
    arquivo,
    `${JSON.stringify(
      {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const envPath = caminhoEnv();
  if (envPath) {
    try {
      const atual = readFileSync(envPath, "utf8");
      const proximo = upsertLinhaEnv(
        upsertLinhaEnv(atual, "ML_ACCESS_TOKEN", tokens.accessToken),
        "ML_REFRESH_TOKEN",
        tokens.refreshToken,
      );
      writeFileSync(envPath, proximo);
    } catch (erro) {
      console.warn(
        `Não foi possível gravar tokens no .env (${envPath}): ${erro instanceof Error ? erro.message : String(erro)}`,
      );
    }
  }

  process.env.ML_ACCESS_TOKEN = tokens.accessToken;
  process.env.ML_REFRESH_TOKEN = tokens.refreshToken;
}

async function chamarOauth(refreshToken: string): Promise<TokensMl> {
  const clientId = process.env.ML_CLIENT_ID?.trim();
  const clientSecret = process.env.ML_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Defina ML_CLIENT_ID e ML_CLIENT_SECRET para renovar o token do Mercado Livre");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetch(OAUTH, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as OauthResposta;
  if (!res.ok || !json.access_token || !json.refresh_token) {
    const detalhe = json.error_description || json.message || json.error || `HTTP ${res.status}`;
    throw new Error(`Falha ao renovar ML_ACCESS_TOKEN: ${detalhe}`);
  }

  const expiresIn = Number(json.expires_in) || 21_600;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

async function renovarAgora(): Promise<string> {
  hidratarMemoria();
  const refresh = memoria?.refreshToken || process.env.ML_REFRESH_TOKEN?.trim() || "";
  if (!refresh) {
    const atual = memoria?.accessToken || process.env.ML_ACCESS_TOKEN?.trim() || "";
    if (atual) return atual;
    throw new Error("Defina ML_REFRESH_TOKEN (e ML_CLIENT_ID / ML_CLIENT_SECRET) no .env");
  }

  const novos = await chamarOauth(refresh);
  memoria = novos;
  persistir(novos);
  if (novos.expiresAt) {
    const min = Math.round((novos.expiresAt - Date.now()) / 60_000);
    console.log(`▶ token ML renovado (~${min} min)`);
  }
  return novos.accessToken;
}

/** Garante um access token válido. Renova se estiver expirado, sem expires_at, ou se forcar=true. */
export async function accessTokenMl(opts?: { forcar?: boolean }): Promise<string> {
  hidratarMemoria();
  if (!opts?.forcar && tokenAindaValido(memoria)) {
    return memoria!.accessToken;
  }

  if (!credenciaisRefreshMl()) {
    const atual = memoria?.accessToken || process.env.ML_ACCESS_TOKEN?.trim() || "";
    if (atual) return atual;
    throw new Error("Defina ML_ACCESS_TOKEN ou o trio ML_CLIENT_ID / ML_CLIENT_SECRET / ML_REFRESH_TOKEN");
  }

  if (!renovacao) {
    renovacao = renovarAgora().finally(() => {
      renovacao = null;
    });
  }
  return renovacao;
}
