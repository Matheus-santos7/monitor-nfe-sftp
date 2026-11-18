import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classificarEntregas,
  concluirRelatorio,
  decidirAcao,
  erroDeConsulta,
  horarioTabelaEBrasilia,
  montarPassos,
  type RelatorioDiagnostico,
} from "./diagnostico.js";
import { comSessaoNerus, queryNerus } from "./nerus-db.js";
import { JANELA_CONTINGENCIA_MS, liberarContingencia, reservarContingencia } from "./nerus-contigencia.js";

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
  assert.match(d.diagnostico, /não avisou o sistema/);
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
  assert.match(d.diagnostico, /falhou/i);
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

test("montarPassos: 4 etapas da integração, alvos ASC em Brasília", () => {
  const passos = montarPassos({
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

  assert.equal(passos.length, 4);
  assert.equal(passos[0].titulo, "Mercado Livre avisou o sistema? Sim");
  assert.match(passos[0].detalhe, /19:10:03/);
  assert.doesNotMatch(passos[0].detalhe, /chave/);
  assert.equal(passos[1].titulo, "O sistema processou o aviso? Atenção");
  assert.match(passos[1].detalhe, /^ok às /);
  assert.match(passos[1].detalhe, /falhou às /);
  assert.ok(passos[1].detalhe.indexOf("ok") < passos[1].detalhe.indexOf("falhou"));
  assert.equal(passos[2].titulo, "Nota registrada no Nerus? Sim");
  assert.equal(passos[2].detalhe, "autorizada");
  assert.equal(passos[3].titulo, "XML enviado ao FTP? Sim");
  assert.match(passos[3].detalhe, /enviado/);
});

function baseRelatorio(
  over: Partial<Omit<RelatorioDiagnostico, "assunto" | "mensagem">> = {},
): Omit<RelatorioDiagnostico, "assunto" | "mensagem"> {
  const decisao = decidirAcao({
    notificacao: null,
    alvos: [],
    invoice: null,
    entregas: [],
  });
  const passos = montarPassos({
    notificacao: null,
    alvos: [],
    invoice: null,
    entregas: [],
  });
  passos.push({
    id: "contigencia",
    titulo: "Contingência",
    status: "ok",
    detalhe: "Aviso reenviado ao sistema.",
  });
  return {
    referencia: "6549/2",
    invoiceId: "6837976790",
    chave: "35260833115817001802550020000065491986846029",
    numero: 6549,
    serie: 2,
    notificacaoRecebida: false,
    entregaEnviada: false,
    precisaAdmin: true,
    proximaAcao: "contigencia",
    diagnostico: decisao.diagnostico,
    passos,
    contigencia: { notificationId: "e245afd8-6ab6-41c3-8585-6c2946be49ed", httpStatus: 200 },
    ...over,
  };
}

test("relatório: rastro técnico percorre tabelas, ids e status", () => {
  const r = concluirRelatorio(
    baseRelatorio({
      notificacaoRecebida: true,
      notificacao: {
        id: "484ce485-a27c-4e02-ad2b-4129dddf9c40",
        date_notification: "2026-08-24 22:10:03",
      },
      alvos: [
        { id: "alvo-1", status: "SUCCESS", retry_count: 0, last_retry: "2026-08-24 22:11:00" },
      ],
      invoice: { id: "gffumh3i", status: "AUTHORIZED", channel_status: "OK", key_nfe: "35260833115817001802550020000065491986846029" },
      entregas: [{ id: "del-1", status: "SENT", created_at: "2026-08-24 22:15:00", updated_at: "2026-08-24 22:16:00" }],
      proximaAcao: "rechecar_ftp",
      contigencia: null,
    }),
  );
  const tecnico = r.mensagem.split("Rastro técnico")[1] || "";
  assert.match(tecnico, /notification_control_id=484ce485-a27c-4e02-ad2b-4129dddf9c40/);
  assert.match(tecnico, /status=SUCCESS/);
  assert.match(tecnico, /id=gffumh3i status=AUTHORIZED/);
  assert.match(tecnico, /status=SENT/);
  assert.match(tecnico, /não disparada \(não era falta de aviso do ML\)/);
});

test("erroDeConsulta: ERRO na tabela é distinguível de 0 linhas", () => {
  assert.equal(
    erroDeConsulta([{ n: 1, tabela: "nerus_o2.invoice", executado: true, filtro: "", linhas: 0, detalhe: "0 linhas" }]),
    undefined,
  );
  const falha = erroDeConsulta([
    { n: 1, tabela: "nerus_gateway.notification_control", executado: true, filtro: "", linhas: 0, detalhe: "ERRO: SSH timeout" },
  ]);
  assert.equal(falha?.tabela, "nerus_gateway.notification_control");
});

test("trava de contingência: mesma invoice não é renotificada duas vezes em 30 min", () => {
  const t0 = Date.UTC(2026, 10, 18, 12, 0);
  assert.equal(reservarContingencia("inv-trava", t0), null);
  assert.equal(reservarContingencia("inv-trava", t0 + 5 * 60_000), t0);
  assert.equal(reservarContingencia("outra-inv", t0 + 5 * 60_000), null);
  assert.equal(reservarContingencia("inv-trava", t0 + JANELA_CONTINGENCIA_MS), null);
  liberarContingencia("inv-trava");
  assert.equal(reservarContingencia("inv-trava", t0 + JANELA_CONTINGENCIA_MS + 1), null);
});

test("sessão Nerus: queries do mesmo ciclo reaproveitam uma única abertura (falha não se repete por NF)", async () => {
  const antes = process.env.NERUS_SSH_HOST;
  delete process.env.NERUS_SSH_HOST; // abertura falha na hora, sem rede
  try {
    const erros = await comSessaoNerus(async () => [
      await queryNerus("SELECT 1").catch((e: unknown) => e),
      await queryNerus("SELECT 2").catch((e: unknown) => e),
    ]);
    assert.ok(erros[0] instanceof Error);
    assert.equal(erros[0], erros[1]); // mesmo objeto = abriu uma vez só
    const [a, b] = [await queryNerus("SELECT 1").catch((e: unknown) => e), await queryNerus("SELECT 2").catch((e: unknown) => e)];
    assert.notEqual(a, b); // fora da sessão, cada query abre a sua
  } finally {
    if (antes !== undefined) process.env.NERUS_SSH_HOST = antes;
  }
});

test("relatório: contingência segurada pela trava diz que o aviso já foi reenviado", () => {
  const r = concluirRelatorio(
    baseRelatorio({
      proximaAcao: "contigencia",
      passos: [{ id: "contigencia", titulo: "Contingência", status: "info", detalhe: "Aviso já reenviado às 10:05; não repetido (janela de 30 min)." }],
    }),
  );
  assert.match(r.mensagem, /já reenviado às 10:05/);
  assert.doesNotMatch(r.mensagem, /não é falta de notificação/);
});
