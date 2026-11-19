import { test } from "node:test";
import assert from "node:assert/strict";
import { conferirLote, contingenciaLigada, rodarCiclo, type DepsCiclo } from "./ciclo.js";
import type { ResultadoJob } from "./job.js";
import type { RelatorioDiagnostico } from "./diagnostico.js";
import { relatorioNota } from "./relatorio.js";

type Nota = { numero: number; serie: number };
// por padrão as notas estão ausentes há 1 h (já são furo); `desdeMin` controla a idade para testar a tolerância
const job = (notas: Nota[], avisos: string[] = [], semXml = false, desdeMin: Record<string, number> = {}, agora = Date.now()): ResultadoJob => ({
  identificador: "Cliente X",
  series: [{ serie: 2, cnpj: "", total: 9, min: 100, max: 110, pulos: [], totalAusentes: semXml ? -1 : notas.length, tetoMl: 110 }],
  integracaoOk: notas.length === 0 && !semXml,
  notasAusentes: notas,
  avisos,
  ausentesDesde: Object.fromEntries(
    notas.map((n) => [`${n.numero}/${n.serie}`, new Date(agora - (desdeMin[`${n.numero}/${n.serie}`] ?? 60) * 60_000).toISOString()]),
  ),
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
  assert.match(r.mensagens[0].mensagem, /série com o Mercado Livre[\s\S]*execução=7/);
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

test("contingência só liga com CONTINGENCIA=on explícito; vazio ou ausente = desligada", () => {
  const antes = process.env.CONTINGENCIA;
  try {
    for (const [v, esperado] of [[undefined, false], ["", false], ["  ", false], ["off", false], ["ligado", false], ["on", true], ["ON", true], ["true", true], ["1", true]] as const) {
      if (v === undefined) delete process.env.CONTINGENCIA;
      else process.env.CONTINGENCIA = v;
      assert.equal(contingenciaLigada(), esperado, `CONTINGENCIA=${JSON.stringify(v)}`);
    }
  } finally {
    if (antes === undefined) delete process.env.CONTINGENCIA;
    else process.env.CONTINGENCIA = antes;
  }
});

test("tolerância: ausentes há < 20 min ficam em trânsito — sem diagnóstico, sem contingência, sem aviso no Chat", async () => {
  const agora = Date.now();
  const notas = [{ numero: 201, serie: 2 }, { numero: 202, serie: 2 }];
  const d = deps({ checar: async () => job(notas, [], false, { "201/2": 5, "202/2": 19 }, agora), acoes: { 201: "contigencia", 202: "contigencia" } });
  const r = await rodarCiclo(d, "1", new Date(agora));
  assert.equal(r.status, "em_transito");
  assert.deepEqual(r.lote, []);
  assert.deepEqual(r.mensagens, []);
  assert.deepEqual(d.contingencias, [], "nada diagnosticado: nenhuma contingência");
  assert.deepEqual(r.emTransito.map((n) => [n.numero, n.haMin]), [[201, 5], [202, 19]]);
  assert.match(r.avisos.join(" "), /2 nota\(s\) em trânsito há até 19 min \(viram furo com 20 min\)/);
  assert.notEqual(r.status, "ok", "em trânsito nunca é verde");
});

test("tolerância: fronteira — 19 min em trânsito, 20 e 21 min já são furo (só os furos vão ao diagnóstico)", async () => {
  const agora = Date.now();
  const notas = [{ numero: 301, serie: 2 }, { numero: 302, serie: 2 }, { numero: 303, serie: 2 }];
  const d = deps({ checar: async () => job(notas, [], false, { "301/2": 19, "302/2": 20, "303/2": 21 }, agora), acoes: { 302: "esperar_entrega", 303: "esperar_entrega" } });
  const r = await rodarCiclo(d, "1", new Date(agora));
  assert.equal(r.status, "alerta");
  assert.deepEqual(r.lote.map((i) => i.numero), [302, 303]);
  assert.deepEqual(r.emTransito.map((n) => n.numero), [301]);
});

test("tolerância: nota nunca vista antes conta a partir de agora (em trânsito, não some)", async () => {
  const agora = Date.now();
  const base = job([{ numero: 401, serie: 2 }], [], false, {}, agora);
  const r = await rodarCiclo(deps({ checar: async () => ({ ...base, ausentesDesde: {} }) }), "1", new Date(agora));
  assert.equal(r.status, "em_transito");
  assert.deepEqual(r.emTransito.map((n) => [n.numero, n.haMin]), [[401, 0]]);
});

test("tolerância: último ciclo do dia (ignorarTolerancia) trata nota de 5 min como furo", async () => {
  const agora = Date.now();
  const d = deps({ checar: async () => job([{ numero: 501, serie: 2 }], [], false, { "501/2": 5 }, agora), acoes: { 501: "esperar_entrega" } });
  const r = await rodarCiclo(d, "1", new Date(agora), { ignorarTolerancia: true });
  assert.equal(r.status, "alerta");
  assert.deepEqual(r.lote.map((i) => i.numero), [501]);
});

test("tolerância: série sem XML continua alerta (não é 'em trânsito')", async () => {
  const r = await rodarCiclo(deps({ checar: async () => job([], [], true) }), "1");
  assert.equal(r.status, "alerta");
});
