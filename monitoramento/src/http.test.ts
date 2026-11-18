import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import { autorizado } from "./http.js";

const req = (headers: Record<string, string> = {}) => ({ headers }) as unknown as IncomingMessage;

test("autorizado: sem token configurado nega tudo (POST /ciclo dispara contingência real)", () => {
  assert.equal(autorizado(req({ authorization: "Bearer " }), undefined), false);
  assert.equal(autorizado(req(), ""), false);
});

test("autorizado: Bearer e X-Token; ?token= só vale no /painel", () => {
  assert.equal(autorizado(req({ authorization: "Bearer s3gredo" }), "s3gredo"), true);
  assert.equal(autorizado(req({ "x-token": "s3gredo" }), "s3gredo"), true);
  assert.equal(autorizado(req({ authorization: "Bearer errado" }), "s3gredo"), false);
  assert.equal(autorizado(req(), "s3gredo", new URL("http://x/painel?token=s3gredo")), true);
  assert.equal(autorizado(req(), "s3gredo", new URL("http://x/ciclo?token=s3gredo")), false);
});
