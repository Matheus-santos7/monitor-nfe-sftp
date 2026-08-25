import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classificarEntregas,
  decidirAcao,
  horarioTabelaEBrasilia,
  montarPassos,
} from "./diagnostico.js";

test("classificarEntregas: SENT ganha de pending", () => {
  assert.equal(classificarEntregas([{ status: "PENDING" }, { status: "SENT" }]), "enviada");
  assert.equal(classificarEntregas([{ status: "pending" }]), "pendente");
  assert.equal(classificarEntregas([{ status: "PROCESSING" }]), "pendente");
  assert.equal(classificarEntregas([{ status: "RETRY_SCHEDULED" }]), "pendente");
  assert.equal(classificarEntregas([{ status: "FAILED" }]), "falhou");
  assert.equal(classificarEntregas([{ status: "SKIPPED" }]), "falhou");
  assert.equal(classificarEntregas([{ status: "CANCELED" }]), "falhou");
  assert.equal(classificarEntregas([]), "ausente");
});

test("horarioTabelaEBrasilia: DATETIME UTC vira Brasília", () => {
  const t = horarioTabelaEBrasilia("2026-08-24 22:10:03");
  assert.match(t, /2026-08-24 22:10:03/);
  assert.match(t, /19:10:03/);
  assert.match(t, /Brasília/);
});

test("sem notificação no gateway → contingência", () => {
  const d = decidirAcao({ notificacao: null, alvos: [], invoice: null, entregas: [] });
  assert.equal(d.proximaAcao, "contigencia");
  assert.equal(d.precisaAdmin, true);
});

test("notificou e invoice SENT → rechecar FTP", () => {
  const d = decidirAcao({
    notificacao: { id: "abc" },
    alvos: [{ status: "SUCCESS" }, { status: "ERROR" }],
    invoice: { id: "q1", status: "AUTHORIZED" },
    entregas: [{ status: "SENT" }],
  });
  assert.equal(d.proximaAcao, "rechecar_ftp");
  assert.equal(d.precisaAdmin, false);
});

test("notificou, integrada, pending → esperar 10 min", () => {
  const d = decidirAcao({
    notificacao: { id: "abc" },
    alvos: [{ status: "SUCCESS" }],
    invoice: { id: "q1" },
    entregas: [{ status: "PENDING" }],
  });
  assert.equal(d.proximaAcao, "esperar_entrega");
});

test("notificou, integrada, FAILED → admin sem espera", () => {
  const d = decidirAcao({
    notificacao: { id: "abc" },
    alvos: [{ status: "SUCCESS" }],
    invoice: { id: "q1" },
    entregas: [{ status: "FAILED" }],
  });
  assert.equal(d.proximaAcao, "nenhuma");
  assert.equal(d.precisaAdmin, true);
  assert.match(d.diagnostico, /FAILED/);
});

test("notificou mas sem invoice → admin, sem contingência", () => {
  const d = decidirAcao({
    notificacao: { id: "abc" },
    alvos: [{ status: "ERROR" }],
    invoice: null,
    entregas: [],
  });
  assert.equal(d.proximaAcao, "nenhuma");
  assert.equal(d.precisaAdmin, true);
});

test("montarPassos: 5 passos, chave completa, alvos ASC", () => {
  const passos = montarPassos({
    invoiceId: "6829992181",
    chave: "35260800000000000191550020000063981000000010",
    notificacao: {
      id: "484ce485-a27c-4e02-ad2b-4129dddf9c40",
      date_notification: "2026-08-24 22:10:03",
    },
    alvos: [
      { status: "ERROR", last_retry: "2026-08-24 22:20:00" },
      { status: "SUCCESS", last_retry: "2026-08-24 22:11:00" },
    ],
    invoice: { id: "gffumh3i", status: "AUTHORIZED" },
    entregas: [{ status: "SENT", created_at: "2026-08-24 22:15:00" }],
  });

  assert.equal(passos.length, 5);
  assert.match(passos[0].titulo, /\[ok\]/);
  assert.match(passos[0].detalhe, /chave completa: 35260800000000000191550020000063981000000010/);
  assert.match(passos[1].titulo, /\[OK\]/);
  assert.match(passos[1].detalhe, /484ce485-a27c-4e02-ad2b-4129dddf9c40/);
  assert.match(passos[2].detalhe, /^SUCCESS \(/);
  assert.match(passos[2].detalhe, /ERROR \(/);
  assert.ok(passos[2].detalhe.indexOf("SUCCESS") < passos[2].detalhe.indexOf("ERROR"));
  assert.equal(passos[3].titulo, "Nota no Nerus? SIM");
  assert.match(passos[3].detalhe, /invoice_id gffumh3i status AUTHORIZED/);
  assert.match(passos[4].detalhe, /SENT/);
});
