import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import { acessoBearer, acessoSessao, origemDoPainel } from "./http.js";
import { criarSessao, gerarLinhaConta, lerContas } from "./sessao.js";

const req = (headers: Record<string, string> = {}) => ({ headers, socket: {} }) as unknown as IncomingMessage;
const SEGREDO = "s".repeat(40);

test("Bearer: só o token de operação, só por header; sem token configurado nada vale", () => {
  assert.equal(acessoBearer(req({ authorization: "Bearer op" }), "op")?.papel, "operacao");
  assert.equal(acessoBearer(req({ "x-token": "op" }), "op")?.papel, "operacao");
  assert.equal(acessoBearer(req({ authorization: "Bearer errado" }), "op"), null);
  assert.equal(acessoBearer(req({ authorization: "Bearer " }), undefined), null);
  assert.equal(acessoBearer(req({ authorization: "Bearer op" }), ""), null);
});

test("sessão por cookie: vale com segredo; sem SESSAO_SEGREDO nenhuma sessão vale", async () => {
  const contas = lerContas(await gerarLinhaConta("cliente", "leitura", "senha-bem-longa-123"));
  const tok = criarSessao(contas.get("cliente")!, SEGREDO);
  const r = req({ cookie: `outro=1; monitor_sessao=${tok}` });
  assert.deepEqual(acessoSessao(r, contas, SEGREDO), { usuario: "cliente", papel: "leitura", via: "sessao" });
  assert.equal(acessoSessao(r, contas, undefined), null);
  assert.equal(acessoSessao(req({ cookie: "monitor_sessao=lixo" }), contas, SEGREDO), null);
});

test("CSRF: exige X-Painel: 1 e Origin do painel (config), nunca o Host", () => {
  const ok = { "x-painel": "1", origin: "https://monitor.exemplo.com", host: "api:8080" };
  assert.equal(origemDoPainel(req(ok), "monitor.exemplo.com", "8080"), true);
  assert.equal(origemDoPainel(req({ ...ok, origin: "https://evil.exemplo" }), "monitor.exemplo.com", "8080"), false);
  assert.equal(origemDoPainel(req({ origin: "https://monitor.exemplo.com" }), "monitor.exemplo.com", "8080"), false);
  assert.equal(origemDoPainel(req({ "x-painel": "1" }), "monitor.exemplo.com", "8080"), false);
  // produção: origem local não vale; desenvolvimento (*.localhost): vale a porta do painel
  assert.equal(origemDoPainel(req({ "x-painel": "1", origin: "http://localhost:8080" }), "monitor.exemplo.com", "8080"), false);
  assert.equal(origemDoPainel(req({ "x-painel": "1", origin: "http://localhost:8080" }), "painel.localhost", "8080"), true);
  assert.equal(origemDoPainel(req({ "x-painel": "1", origin: "http://localhost:9999" }), "painel.localhost", "8080"), false);
});
