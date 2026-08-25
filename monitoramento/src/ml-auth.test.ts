import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accessTokenMl,
  resetMlAuthForTests,
  upsertLinhaEnv,
} from "./ml-auth.js";

test("upsertLinhaEnv atualiza ML_ACCESS_TOKEN sem mexer no resto", () => {
  const origem = "FOO=1\nML_ACCESS_TOKEN=velho\nML_REFRESH_TOKEN=tg-old\nBAR=2\n";
  const out = upsertLinhaEnv(upsertLinhaEnv(origem, "ML_ACCESS_TOKEN", "novo"), "ML_REFRESH_TOKEN", "tg-new");
  assert.match(out, /^ML_ACCESS_TOKEN=novo$/m);
  assert.match(out, /^ML_REFRESH_TOKEN=tg-new$/m);
  assert.match(out, /^FOO=1$/m);
  assert.match(out, /^BAR=2$/m);
});

test("accessTokenMl renova, persiste arquivo e .env, e reusa enquanto válido", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ml-auth-"));
  const tokensPath = join(dir, "ml-tokens.json");
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "ML_ACCESS_TOKEN=APP_USR-expired\nML_REFRESH_TOKEN=TG-old\nOUTRA=ok\n");

  const prev = {
    fetch: globalThis.fetch,
    client: process.env.ML_CLIENT_ID,
    secret: process.env.ML_CLIENT_SECRET,
    access: process.env.ML_ACCESS_TOKEN,
    refresh: process.env.ML_REFRESH_TOKEN,
    tokens: process.env.ML_TOKENS_PATH,
    env: process.env.ML_ENV_PATH,
  };

  let oauthCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/oauth/token")) {
      oauthCalls += 1;
      return new Response(
        JSON.stringify({
          access_token: "APP_USR-novo",
          refresh_token: "TG-novo",
          expires_in: 21600,
          user_id: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`fetch inesperado: ${url}`);
  }) as typeof fetch;

  process.env.ML_CLIENT_ID = "id";
  process.env.ML_CLIENT_SECRET = "secret";
  process.env.ML_ACCESS_TOKEN = "APP_USR-expired";
  process.env.ML_REFRESH_TOKEN = "TG-old";
  process.env.ML_TOKENS_PATH = tokensPath;
  process.env.ML_ENV_PATH = envPath;
  resetMlAuthForTests();

  try {
    const primeiro = await accessTokenMl();
    assert.equal(primeiro, "APP_USR-novo");
    assert.equal(oauthCalls, 1);
    assert.equal(process.env.ML_ACCESS_TOKEN, "APP_USR-novo");
    assert.equal(process.env.ML_REFRESH_TOKEN, "TG-novo");

    const gravado = JSON.parse(readFileSync(tokensPath, "utf8")) as { access_token: string; refresh_token: string };
    assert.equal(gravado.access_token, "APP_USR-novo");
    assert.equal(gravado.refresh_token, "TG-novo");

    const env = readFileSync(envPath, "utf8");
    assert.match(env, /^ML_ACCESS_TOKEN=APP_USR-novo$/m);
    assert.match(env, /^ML_REFRESH_TOKEN=TG-novo$/m);
    assert.match(env, /^OUTRA=ok$/m);

    const segundo = await accessTokenMl();
    assert.equal(segundo, "APP_USR-novo");
    assert.equal(oauthCalls, 1, "não deve renovar de novo com token ainda válido");
  } finally {
    globalThis.fetch = prev.fetch;
    process.env.ML_CLIENT_ID = prev.client;
    process.env.ML_CLIENT_SECRET = prev.secret;
    process.env.ML_ACCESS_TOKEN = prev.access;
    process.env.ML_REFRESH_TOKEN = prev.refresh;
    process.env.ML_TOKENS_PATH = prev.tokens;
    process.env.ML_ENV_PATH = prev.env;
    resetMlAuthForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
