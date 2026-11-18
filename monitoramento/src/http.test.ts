import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import { permissao } from "./http.js";

const req = (headers: Record<string, string> = {}) => ({ headers }) as unknown as IncomingMessage;
const t = { operacao: "op-s3gredo", leitura: "le-s3gredo" };

test("permissao: sem token de operação configurado nega tudo (Executar agora dispara contingência real)", () => {
  assert.equal(permissao(req({ authorization: "Bearer le-s3gredo" }), { leitura: "le-s3gredo" }), null);
  assert.equal(permissao(req({ authorization: "Bearer " }), {}), null);
});

test("permissao: operação e leitura por Bearer ou X-Token; token errado = null", () => {
  assert.equal(permissao(req({ authorization: "Bearer op-s3gredo" }), t), "operacao");
  assert.equal(permissao(req({ "x-token": "op-s3gredo" }), t), "operacao");
  assert.equal(permissao(req({ authorization: "Bearer le-s3gredo" }), t), "leitura");
  assert.equal(permissao(req({ "x-token": "le-s3gredo" }), t), "leitura");
  assert.equal(permissao(req({ authorization: "Bearer errado" }), t), null);
  assert.equal(permissao(req(), t), null);
});

test("permissao: sem PAINEL_TOKEN só o de operação entra; leitura igual à operação não rebaixa", () => {
  assert.equal(permissao(req({ authorization: "Bearer le-s3gredo" }), { operacao: "op-s3gredo" }), null);
  assert.equal(permissao(req({ authorization: "Bearer mesmo" }), { operacao: "mesmo", leitura: "mesmo" }), "operacao");
});
