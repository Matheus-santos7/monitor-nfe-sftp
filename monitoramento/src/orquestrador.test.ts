import assert from "node:assert/strict";
import { test } from "node:test";
import { executarCicloCompleto, modoAgenda, type DepsOrquestrador } from "./orquestrador.js";
import type { ResultadoCiclo, ResultadoConferencia } from "./ciclo.js";
import type { ItemLote, Mensagem } from "./relatorio.js";

const nota = { numero: 10, serie: 2 };
const item: ItemLote = { referencia: "10/2", numero: 10, serie: 2, invoiceId: "i", proximaAcao: "esperar_entrega", diagnostico: "d" };
const m = (assunto: string): Mensagem => ({ assunto, mensagem: assunto });

function ciclo(extra: Partial<ResultadoCiclo>): ResultadoCiclo {
  return { status: "ok", identificador: "x", avisos: [], notasAusentes: [], lote: [], emTransito: [], espera: "nenhuma", mensagens: [m("resumo")], ...extra };
}
function conf(aindaFaltam: boolean, assunto: string): ResultadoConferencia {
  return { aindaFaltam, faltando: aindaFaltam ? [nota] : [], noFtp: aindaFaltam ? 0 : 1, total: 1, mensagens: [m(assunto)] };
}

function deps(over: Partial<DepsOrquestrador> & { conferencias?: ResultadoConferencia[] } = {}) {
  const log = { esperas: [] as number[], enviadas: [] as string[], registros: [] as string[], contingencia: [] as boolean[] };
  const fila = [...(over.conferencias ?? [])];
  const d: DepsOrquestrador = {
    ciclo: async (_e, o) => (log.contingencia.push(o.contingencia), ciclo({})),
    conferir: async () => fila.shift()!,
    enviar: async (x) => (log.enviadas.push(x.assunto), { entregues: ["Google Chat"], falhas: [] }),
    esperar: async (ms) => void log.esperas.push(ms),
    registrar: (t) => void log.registros.push(t),
    agora: () => new Date("2026-11-18T13:00:00Z"),
    ...over,
  };
  return { d, log };
}
const rodar = (d: DepsOrquestrador, sombra = false) => executarCicloCompleto(d, { execucao: "t", origem: "agenda", sombra });

test("sem lote: envia o resumo do ciclo, sem esperar nem conferir", async () => {
  const { d, log } = deps();
  const r = await rodar(d);
  assert.equal(r.status, "ok");
  assert.deepEqual(log.esperas, []);
  assert.deepEqual(log.enviadas, ["resumo"]);
});

test("lote resolvido na 1ª conferência: espera do lote (10 min) e envia os relatórios da conferência", async () => {
  const { d, log } = deps({
    ciclo: async () => ciclo({ status: "alerta", notasAusentes: [nota], lote: [item], espera: "10min", mensagens: [] }),
    conferencias: [conf(false, "lote ok")],
  });
  await rodar(d);
  assert.deepEqual(log.esperas, [600_000]);
  assert.deepEqual(log.enviadas, ["lote ok"]);
});

test("ainda faltando: espera mais 2 min, confere de novo e envia só o resultado final", async () => {
  const { d, log } = deps({
    ciclo: async () => ciclo({ status: "alerta", notasAusentes: [nota], lote: [item], espera: "2min", mensagens: [] }),
    conferencias: [conf(true, "parcial"), conf(true, "final")],
  });
  await rodar(d);
  assert.deepEqual(log.esperas, [120_000, 120_000]);
  assert.deepEqual(log.enviadas, ["final"]);
});

test("erro no ciclo ou na conferência vira aviso de falha com a etapa (o antigo Error Handler)", async () => {
  const a = deps({ ciclo: async () => { throw new Error("SFTP fora"); } });
  const r = await rodar(a.d);
  assert.equal(r.status, "falhou");
  assert.equal(r.etapaFalha, "ciclo");
  assert.deepEqual(a.log.enviadas, ["Falha no ciclo de monitoramento NF-e"]);

  const b = deps({
    ciclo: async () => ciclo({ status: "alerta", notasAusentes: [nota], lote: [item], espera: "nenhuma", mensagens: [] }),
    conferir: async () => { throw new Error("timeout"); },
  });
  const r2 = await rodar(b.d);
  assert.equal(r2.etapaFalha, "conferência");
  assert.match(r2.erro ?? "", /timeout/);
});

test("nenhum canal entregou: registra no histórico (não termina 'verde' calado)", async () => {
  const { d, log } = deps({ enviar: async () => ({ entregues: [], falhas: [{ canal: "Google Chat", erro: "HTTP 500" }] }) });
  const r = await rodar(d);
  assert.equal(r.semEntrega, 1);
  assert.match(log.registros[0], /não foi entregue em nenhum canal \(Google Chat: HTTP 500\)/);
});

test("sombra: ciclo sem contingência e nenhum aviso enviado", async () => {
  const { d, log } = deps();
  await rodar(d, true);
  assert.deepEqual(log.contingencia, [false]);
  assert.deepEqual(log.enviadas, []);
  const normal = deps();
  await rodar(normal.d, false);
  assert.deepEqual(normal.log.contingencia, [true]);
});

test("modoAgenda: só 'sombra' e 'ativo' ligam; o resto é off", () => {
  assert.equal(modoAgenda({}), "off");
  assert.equal(modoAgenda({ MODO_AGENDA: "ATIVO" }), "ativo");
  assert.equal(modoAgenda({ MODO_AGENDA: "sombra" }), "sombra");
  assert.equal(modoAgenda({ MODO_AGENDA: "on" }), "off");
});

test("último ciclo agendado do dia (18h em São Paulo) pede para ignorar a tolerância; manual e outros horários não", async () => {
  const pedidos: boolean[] = [];
  const mk = (iso: string) => deps({ ciclo: async (_e, o) => (pedidos.push(o.ignorarTolerancia), ciclo({})), agora: () => new Date(iso) });
  await executarCicloCompleto(mk("2026-11-19T21:00:00Z").d, { execucao: "a", origem: "agenda", sombra: false }); // 18h SP
  await executarCicloCompleto(mk("2026-11-19T20:00:00Z").d, { execucao: "b", origem: "agenda", sombra: false }); // 17h SP
  await executarCicloCompleto(mk("2026-11-19T21:00:00Z").d, { execucao: "c", origem: "manual", sombra: false }); // manual 18h
  assert.deepEqual(pedidos, [true, false, false]);
});
