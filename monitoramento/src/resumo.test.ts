import assert from "node:assert/strict";
import { test } from "node:test";
import { deveAvisar, diasDoPeriodo, inicioPeriodo, linkPainel, paraChat, resumoPeriodo } from "./resumo.js";
import type { DiaHistorico } from "./historico.js";

test("paraChat: título em negrito, sem rastro técnico, com link do painel", () => {
  const m = paraChat({ assunto: "NF-e 10/2 — ainda ausente", mensagem: "NF 10/2\n\n⚠️ Ainda não resolvido\n\nRastro técnico\ninvoice_id=123\ntabela=x" }, "https://monitor.exemplo.com");
  assert.match(m.mensagem, /^\*NF-e 10\/2 — ainda ausente\*/);
  assert.doesNotMatch(m.mensagem, /Rastro técnico|invoice_id|tabela/);
  assert.match(m.mensagem, /Detalhes: https:\/\/monitor\.exemplo\.com$/);
  assert.doesNotMatch(paraChat({ assunto: "x", mensagem: "y" }, null).mensagem, /Detalhes/);
});

test("linkPainel: só com DNS real", () => {
  assert.equal(linkPainel("monitor.exemplo.com"), "https://monitor.exemplo.com");
  assert.equal(linkPainel("painel.localhost"), null);
  assert.equal(linkPainel(""), null);
});

test("deveAvisar: alerta sempre; ok só ao voltar ao normal; parcial só ao mudar; em trânsito nunca", () => {
  assert.equal(deveAvisar("alerta", "alerta"), true);
  assert.equal(deveAvisar("falhou", null), true);
  assert.equal(deveAvisar("ok", "ok"), false);
  assert.equal(deveAvisar("ok", null), false);
  assert.equal(deveAvisar("ok", "em_transito"), false);
  assert.equal(deveAvisar("ok", "alerta"), true);
  assert.equal(deveAvisar("ok", "degradado"), true);
  assert.equal(deveAvisar("degradado", "degradado"), false);
  assert.equal(deveAvisar("degradado", "ok"), true);
  assert.equal(deveAvisar("em_transito", "ok"), false);
});

test("inicioPeriodo: 10h → 18h do dia útil anterior (segunda → sexta); 18h → 10h do mesmo dia", () => {
  const sp = (iso: string) => new Date(iso); // horários em UTC; São Paulo = UTC-3
  assert.equal(inicioPeriodo(sp("2026-11-19T13:00:00Z")).toISOString(), "2026-11-18T21:00:00.000Z"); // qui 10h → qua 18h
  assert.equal(inicioPeriodo(sp("2026-11-23T13:00:00Z")).toISOString(), "2026-11-20T21:00:00.000Z"); // seg 10h → sex 18h
  assert.equal(inicioPeriodo(sp("2026-11-19T21:00:00Z")).toISOString(), "2026-11-19T13:00:00.000Z"); // qui 18h → qui 10h
});

test("resumoPeriodo: conta só eventos do período, médias, abertos e falhas", () => {
  const dia = (d: string, eventos: DiaHistorico["eventos"]): DiaHistorico => ({ dia: d, checagens: { total: 0, ok: 0, alerta: 0, erro: 0 }, primeiraEm: null, ultimaEm: null, eventos, abertos: {} });
  const dias = [
    dia("20261118", [
      { em: "2026-11-18T20:00:00Z", tipo: "furo_aberto", texto: "", nota: "1/2" }, // antes do período
      { em: "2026-11-18T22:00:00Z", tipo: "furo_aberto", texto: "", nota: "2/2" },
      { em: "2026-11-18T22:10:00Z", tipo: "furo_resolvido", texto: "", nota: "2/2", duracaoMin: 10 },
    ]),
    dia("20261119", [
      { em: "2026-11-19T05:00:00Z", tipo: "furo_aberto", texto: "", nota: "3/2" },
      { em: "2026-11-19T05:30:00Z", tipo: "furo_resolvido", texto: "", nota: "3/2", duracaoMin: 30 },
      { em: "2026-11-19T06:00:00Z", tipo: "checagem_falhou", texto: "SFTP fora" },
    ]),
  ];
  const fim = new Date("2026-11-19T13:00:00Z");
  const m = resumoPeriodo(dias, new Date("2026-11-18T21:00:00Z"), fim, { "9/2": "2026-11-19T12:00:00Z" }, "Loja X", "https://monitor.exemplo.com");
  assert.match(m.mensagem, /Notas que faltaram no FTP: 2/);
  assert.match(m.mensagem, /Chegaram depois: 2 \(média 20 min, pior 30 min\)/);
  assert.match(m.mensagem, /Ainda faltando agora: 1 \(a mais antiga há 60 min\)/);
  assert.match(m.mensagem, /Falhas de checagem: 1/);
  assert.match(m.mensagem, /^⚠️/);
  assert.match(m.mensagem, /Painel: https:\/\/monitor\.exemplo\.com/);
  const vazio = resumoPeriodo([], new Date("2026-11-18T21:00:00Z"), fim, {}, "Loja X", null);
  assert.match(vazio.mensagem, /^✅[\s\S]*Nenhuma ocorrência no período/);
});

test("diasDoPeriodo: lê cada dia uma vez, incluindo o do fim", () => {
  const lidos: string[] = [];
  diasDoPeriodo(new Date("2026-11-20T21:00:00Z"), new Date("2026-11-23T13:00:00Z"), (d) => (lidos.push(d), null));
  assert.deepEqual(lidos, ["20261120", "20261121", "20261122", "20261123"]);
});
