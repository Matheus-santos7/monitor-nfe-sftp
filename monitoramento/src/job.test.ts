import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registrarChecagem, statusPainel, type ResultadoJob } from "./job.js";
import { lerDia, resumirDia } from "./historico.js";

process.env.HISTORICO_DIR = mkdtempSync(join(tmpdir(), "hist-")); // nunca grava em data/ real

const res = (notas: { numero: number; serie: number }[], avisos: string[] = []): { resultado: ResultadoJob; avisos: string[] } => ({
  resultado: { identificador: "x", series: [], integracaoOk: notas.length === 0, notasAusentes: notas, avisos },
  avisos,
});

test("painel guarda quando cada furo apareceu e limpa o resolvido", () => {
  const t0 = new Date("2026-11-17T12:00:00Z");
  const t1 = new Date("2026-11-17T12:05:00Z");
  registrarChecagem(t0.getTime(), res([{ numero: 10, serie: 1 }]), t0);
  assert.equal(statusPainel().status, "alerta");
  registrarChecagem(t1.getTime(), res([{ numero: 10, serie: 1 }, { numero: 11, serie: 1 }]), t1);
  assert.deepEqual(statusPainel().ausentesDesde, { "10/1": t0.toISOString(), "11/1": t1.toISOString() });
  registrarChecagem(t1.getTime(), { erro: "SFTP fora" }, t1);
  assert.equal(statusPainel().status, "erro");
  assert.equal(statusPainel().ausentesDesde["10/1"], t0.toISOString()); // falha não zera a idade
  registrarChecagem(t1.getTime(), res([]), t1);
  assert.deepEqual(statusPainel().ausentesDesde, {});
  assert.equal(statusPainel().status, "ok");
  registrarChecagem(t1.getTime(), res([], ["Teto ML indisponível"]), t1);
  assert.equal(statusPainel().status, "erro"); // sem teto ML o "ok" não é confiável
});

test("histórico do dia registra furo aberto/resolvido e resume a saúde", async () => {
  const t = (m: number) => new Date(Date.UTC(2026, 11, 2, 13, m)); // 02/12 10:xx SP
  registrarChecagem(t(0).getTime(), res([]), t(0));
  registrarChecagem(t(5).getTime(), res([{ numero: 5, serie: 2 }]), t(5));
  registrarChecagem(t(10).getTime(), { erro: "SFTP fora" }, t(10));
  registrarChecagem(t(15).getTime(), { erro: "SFTP fora" }, t(15)); // mesma falha não repete evento
  registrarChecagem(t(25).getTime(), res([]), t(25));
  const d = lerDia("20261202")!;
  assert.deepEqual(d.eventos.map((e) => e.tipo), ["furo_aberto", "checagem_falhou", "checagem_voltou", "furo_resolvido"]);
  assert.equal(d.eventos[3].duracaoMin, 20);
  assert.deepEqual(d.checagens, { total: 5, ok: 2, alerta: 1, erro: 2 });
  const r = resumirDia(d);
  assert.equal(r.nivel, "atencao");
  assert.equal(r.saudePct, 40);
  assert.equal(r.resolucaoMediaMin, 20);
  assert.equal(r.abertosAgora, 0);
});
