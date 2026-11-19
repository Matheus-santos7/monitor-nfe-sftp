import assert from "node:assert/strict";
import { test } from "node:test";
import { _usarExecutor, avisosBanco, bancoChecagem, bancoCiclo, bancoConfigurado, esperarBanco } from "./db.js";

const evento = { em: "2026-11-19T13:00:00.000Z", tipo: "furo_aberto" as const, texto: "NF 10/2 ausente no FTP", nota: "10/2" };

test("bancoConfigurado: só com DB_HOST e DB_USER", () => {
  assert.equal(bancoConfigurado({}), false);
  assert.equal(bancoConfigurado({ DB_HOST: "172.31.0.1" }), false);
  assert.equal(bancoConfigurado({ DB_HOST: "172.31.0.1", DB_USER: "matheus" }), true);
});

test("checagem + eventos: um INSERT da checagem e um INSERT IGNORE por evento", async () => {
  const sqls: string[] = [];
  _usarExecutor({ execute: async (sql) => void sqls.push(sql.split("(")[0].trim()) });
  bancoChecagem({ em: evento.em, cliente: "Loja X", status: "alerta", duracaoMs: 1200, notasAusentes: 1, avisos: [], eventos: [evento] });
  await esperarBanco();
  assert.deepEqual(sqls, ["INSERT INTO monitor_checagem", "INSERT IGNORE INTO monitor_evento"]);
  assert.deepEqual(avisosBanco(), []);
});

test("banco fora: o chamador não espera nem recebe erro; vira aviso no painel; volta e o aviso some", async () => {
  let fora = true;
  _usarExecutor({ execute: async () => { if (fora) throw new Error("connect ETIMEDOUT"); } });
  const t0 = Date.now();
  bancoCiclo("Loja X", { execucao: "agenda-x", origem: "agenda", sombra: false, status: "ok", inicio: evento.em, fim: evento.em, mensagens: 0, semEntrega: 0, etapaFalha: null, erro: null });
  assert.ok(Date.now() - t0 < 50, "não bloqueia o ciclo");
  await esperarBanco();
  assert.match(avisosBanco()[0], /indisponível: connect ETIMEDOUT/);
  fora = false;
  bancoChecagem({ em: evento.em, cliente: "Loja X", status: "ok", duracaoMs: 1, notasAusentes: 0, avisos: [], eventos: [] });
  await esperarBanco();
  assert.deepEqual(avisosBanco(), []);
});

test("sem banco configurado: nada é gravado e não há aviso", async () => {
  _usarExecutor(null);
  bancoChecagem({ em: evento.em, cliente: "Loja X", status: "ok", duracaoMs: 1, notasAusentes: 0, avisos: [], eventos: [evento] });
  await esperarBanco();
  assert.deepEqual(avisosBanco(), []);
});
