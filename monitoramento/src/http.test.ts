import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import { acessoBearer, acessoSessao, ipCliente, origemDoPainel, viaApiHost } from "./http.js";
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

test("API_HOST: reconhece o endereço da API pelo Host (com ou sem porta, maiúsculas)", () => {
  assert.equal(viaApiHost(req({ host: "api-monitor.exemplo.com" }), "api-monitor.exemplo.com"), true);
  assert.equal(viaApiHost(req({ host: "API-Monitor.exemplo.com:443" }), "api-monitor.exemplo.com"), true);
  assert.equal(viaApiHost(req({ host: "monitor.exemplo.com" }), "api-monitor.exemplo.com"), false);
  assert.equal(viaApiHost(req({ host: "api:8080" }), "api-monitor.exemplo.com"), false, "painel → api pela rede interna");
  assert.equal(viaApiHost(req({ host: "api-monitor.exemplo.com" }), ""), false, "sem API_HOST configurado");
});

test("IP do cliente: pelo API_HOST usa a última entrada do X-Forwarded-For (a do balanceador), ignora X-Real-IP forjado", () => {
  const api = "api-monitor.exemplo.com";
  const pelaApi = req({ host: api, "x-forwarded-for": "6.6.6.6, 203.0.113.9", "x-real-ip": "1.2.3.4" });
  assert.equal(ipCliente(pelaApi, api), "203.0.113.9");
  const pelaApiSemXff = { headers: { host: api, "x-real-ip": "1.2.3.4" }, socket: { remoteAddress: "10.0.0.5" } } as unknown as IncomingMessage;
  assert.equal(ipCliente(pelaApiSemXff, api), "10.0.0.5", "sem XFF: o socket, nunca o X-Real-IP do cliente");
  const peloPainel = req({ host: "api:8080", "x-real-ip": "198.51.100.7", "x-forwarded-for": "198.51.100.7" });
  assert.equal(ipCliente(peloPainel, api), "198.51.100.7", "pelo painel: X-Real-IP escrito pelo nginx");
});
