import { test } from "node:test";
import assert from "node:assert/strict";
import { conferirLote, rodarCiclo, type DepsCiclo } from "./ciclo.js";
import type { ResultadoJob } from "./job.js";
import type { RelatorioDiagnostico } from "./diagnostico.js";
import { relatorioNota } from "./relatorio.js";

type Nota = { numero: number; serie: number };
const job = (notas: Nota[], avisos: string[] = [], semXml = false): ResultadoJob => ({
  identificador: "Cliente X",
  series: [{ serie: 2, cnpj: "", total: 9, min: 100, max: 110, pulos: [], totalAusentes: semXml ? -1 : notas.length, tetoMl: 110 }],
  integracaoOk: notas.length === 0 && !semXml,
  notasAusentes: notas,
  avisos,
});
const diag = (n: Nota, proximaAcao: RelatorioDiagnostico["proximaAcao"]): RelatorioDiagnostico => ({
  referencia: `${n.numero}/${n.serie}`, invoiceId: `inv-${n.numero}`, chave: null, numero: n.numero, serie: n.serie,
  notificacaoRecebida: proximaAcao !== "contigencia", entregaEnviada: false, precisaAdmin: true, proximaAcao,
  diagnostico: `diag ${n.numero}`, passos: [], assunto: "", mensagem: "",
});

function deps(over: Partial<DepsCiclo> & { acoes?: Record<number, RelatorioDiagnostico["proximaAcao"]> }): DepsCiclo & { contingencias: boolean[] } {
  const contingencias: boolean[] = [];
  return {
    contingencias,
    checar: async () => job([]),
    validarMl: async () => ({ id: 42 }),
    localizar: async (n) => ({ encontrado: true, invoiceId: `inv-${n.numero}`, chave: "k" }),
    diagnosticar: async (o) => {
      contingencias.push(Boolean(o.executarContigencia));
      return diag(o, over.acoes?.[o.numero] ?? "nenhuma");
    },
    ...over,
  };
}

test("ciclo sem furo e checagem completa → ok, só o resumo, sem lote", async () => {
  const r = await rodarCiclo(deps({}), "1");
  assert.equal(r.status, "ok");
  assert.equal(r.lote.length, 0);
  assert.match(r.mensagens[0].mensagem, /100% OK/);
});

test("ciclo sem furo mas sem teto ML → degradado, nunca '100% OK' (falso verde)", async () => {
  const r = await rodarCiclo(deps({ checar: async () => job([], ["Teto ML indisponível: 429"]) }), "1");
  assert.equal(r.status, "degradado");
  assert.doesNotMatch(r.mensagens[0].mensagem, /100% OK/);
  assert.match(r.mensagens[0].mensagem, /cobertura parcial[\s\S]*Teto ML indisponível: 429/);
});

test("furo com entrega pendente vence contingência → espera 10 min", async () => {
  const notas = [{ numero: 101, serie: 2 }, { numero: 102, serie: 2 }];
  const r = await rodarCiclo(deps({ checar: async () => job(notas), acoes: { 101: "contigencia", 102: "esperar_entrega" } }), "1");
  assert.equal(r.status, "alerta");
  assert.equal(r.espera, "10min");
  assert.deepEqual(r.lote.map((i) => i.proximaAcao), ["contigencia", "esperar_entrega"]);
  assert.equal(r.mensagens.length, 0); // relatórios saem só na conferência
});

test("só contingência → espera 2 min; CONTINGENCIA=off diagnostica sem renotificar", async () => {
  const d = deps({ checar: async () => job([{ numero: 101, serie: 2 }]), acoes: { 101: "contigencia" } });
  process.env.CONTINGENCIA = "off";
  try {
    const r = await rodarCiclo(d, "1");
    assert.equal(r.espera, "2min");
    assert.deepEqual(d.contingencias, [false]);
  } finally {
    delete process.env.CONTINGENCIA;
  }
});

test("invoice fora do ZIP ou falha no Nerus → NF segue no lote sem derrubar o ciclo", async () => {
  const notas = [{ numero: 101, serie: 2 }, { numero: 102, serie: 2 }];
  const r = await rodarCiclo(
    deps({
      checar: async () => job(notas),
      localizar: async (n) => (n.numero === 101 ? { encontrado: false } : { encontrado: true, invoiceId: "inv-102" }),
      diagnosticar: async () => { throw new Error("SSH caiu"); },
    }),
    "1",
  );
  assert.equal(r.lote.length, 2);
  assert.match(r.lote[0].diagnostico, /não foi encontrada no relatório/);
  assert.match(r.lote[1].diagnostico, /Não foi possível consultar o Nerus: SSH caiu/);
  assert.equal(r.espera, "nenhuma");
});

test("série sem XML → aviso de série, sem lote", async () => {
  const r = await rodarCiclo(deps({ checar: async () => job([], [], true) }), "7");
  assert.equal(r.status, "alerta");
  assert.match(r.mensagens[0].mensagem, /série com o Mercado Livre[\s\S]*execução n8n=7/);
});

test("token ML inválido derruba o ciclo (vai pro Error Handler)", async () => {
  await assert.rejects(
    rodarCiclo(deps({ checar: async () => job([{ numero: 1, serie: 2 }]), validarMl: async () => { throw new Error("401"); } }), "1"),
    /401/,
  );
});

test("conferência: relatório por NF + resumo do lote, com o que ainda falta", async () => {
  const notas = [{ numero: 101, serie: 2 }, { numero: 102, serie: 2 }];
  const { lote } = await rodarCiclo(deps({ checar: async () => job(notas) }), "1");
  const r = await conferirLote({ checar: async () => job([{ numero: 102, serie: 2 }]) }, { notas, lote, execucao: "1" });
  assert.equal(r.aindaFaltam, true);
  assert.deepEqual(r.faltando, [{ numero: 102, serie: 2 }]);
  assert.deepEqual(r.mensagens.map((m) => m.assunto), ["NF-e 101/2 — resolvido", "NF-e 102/2 — ainda ausente no FTP", "Lote de furos — 1/2 no FTP"]);
});

test("relatório do lote: contingência segurada pela trava não diz 'não é falta de notificação'", () => {
  const r = relatorioNota(
    {
      referencia: "10/2",
      numero: 10,
      serie: 2,
      invoiceId: "inv",
      proximaAcao: "contigencia",
      diagnostico: "O Mercado Livre não avisou o sistema.",
      passos: [{ id: "contigencia", titulo: "Contingência", status: "info", detalhe: "Aviso já reenviado às 10:05; não repetido (janela de 30 min)." }],
    },
    [{ numero: 10, serie: 2 }],
    "1",
  );
  assert.match(r.mensagem, /já reenviado às 10:05/);
  assert.doesNotMatch(r.mensagem, /não é falta de notificação/);
});
