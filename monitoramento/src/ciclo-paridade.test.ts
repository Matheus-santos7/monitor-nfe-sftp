// Paridade com o workflow n8n v1: roda o JS original dos nós Code e compara com relatorio.ts.
// Quando o v1 for removido do repositório, este arquivo pode ser apagado (os testes de ciclo.test.ts ficam).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decidirEsperaLote,
  horarioSaoPaulo,
  itemInvoiceAusente,
  mensagemResumo,
  mensagemSerieSemXml,
  relatorioConferencia,
  relatorioNota,
  type ItemLote,
} from "./relatorio.js";
import type { ResultadoSerie } from "./types.js";

const WF = fileURLToPath(new URL("../../workflows/monitor-sftp.json", import.meta.url));
const v1 = existsSync(WF) ? (JSON.parse(readFileSync(WF, "utf8")) as { nodes: { name: string; parameters: { jsCode?: string } }[] }) : null;
const EXEC = "999";

/** Executa um nó Code do v1 com um $input/$()/$env/static data simulados. */
async function rodarNo(
  nome: string,
  ctx: { input: unknown; nodes?: Record<string, unknown>; env?: Record<string, string | undefined>; run?: Record<string, unknown> },
): Promise<Record<string, any>[]> {
  const code = v1!.nodes.find((n) => n.name === nome)?.parameters.jsCode;
  assert.ok(code, `nó ${nome} não encontrado no v1`);
  const $ = (n: string) => ({ first: () => ({ json: ctx.nodes?.[n] }), item: { json: ctx.nodes?.[n] } });
  const $input = { first: () => ({ json: ctx.input }), all: () => [{ json: ctx.input }] };
  const fn = new Function("$input", "$json", "$", "$execution", "$env", "$getWorkflowStaticData", "console", `return (async () => {${code}})()`);
  const out = await fn($input, ctx.input, $, { id: EXEC, customData: { set() {} } }, ctx.env ?? {}, () => ctx.run ?? {}, { log() {} });
  return (out as { json: Record<string, any> }[]).map((o) => o.json);
}

const semHora = (s: string) => s.replace(/\d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}/g, "<hora>");
const pular = { skip: v1 ? false : "workflows/monitor-sftp.json (v1) não está no repositório" };

const serie = (s: Partial<ResultadoSerie>): ResultadoSerie => ({
  serie: 2, cnpj: "", total: 10, min: 100, max: 110, pulos: [], totalAusentes: 0, tetoMl: 110, ...s,
});

test("paridade: resumo OK, com pendências e com FAKE_NOTA", pular, async () => {
  const casos = [
    { series: [serie({}), serie({ serie: 8, min: 50, max: 77, tetoMl: null })], notasAusentes: [], integracaoOk: true, env: {} },
    { series: [serie({ totalAusentes: 3 })], notasAusentes: [{ numero: 105, serie: 2 }, { numero: 106, serie: 2 }, { numero: 109, serie: 2 }], integracaoOk: false, env: {} },
    { series: [serie({})], notasAusentes: [], integracaoOk: true, env: { FAKE_NOTA: "1000/1" } },
  ];
  for (const c of casos) {
    const tetoPeriodo = { start: "20261118", end: "20261118" };
    const [old] = await rodarNo("Montar resumo da checagem", {
      input: { identificador: "Cliente X", series: c.series, notasAusentes: c.notasAusentes, integracaoOk: c.integracaoOk, tetoPeriodo },
      env: c.env,
    });
    // v1 aplica FAKE_NOTA por conta própria; no v2 quem aplica é o monitor (job.ts) antes do resumo.
    const fake = c.env.FAKE_NOTA ? { numero: 1000, serie: 1 } : null;
    const novo = mensagemResumo({
      identificador: "Cliente X",
      series: c.series,
      tetoPeriodo,
      notasAusentes: fake ? [fake, ...c.notasAusentes] : c.notasAusentes,
      integracaoOk: c.integracaoOk && !fake,
      avisos: [],
      fake: Boolean(fake),
      horario: horarioSaoPaulo(),
    });
    assert.equal(semHora(novo.mensagem), semHora(old.mensagem));
    assert.equal(semHora(novo.assunto), semHora(old.assunto));
  }
});

test("paridade: série sem XML e invoice ausente no ML", pular, async () => {
  const [old] = await rodarNo("Série sem XML para cruzar", { input: { identificador: "Cliente X", executionId: EXEC } });
  assert.deepEqual(mensagemSerieSemXml("Cliente X", EXEC), { assunto: old.assunto, mensagem: old.mensagem });

  const run = { lote: [] as Record<string, any>[] };
  const [oldInv] = await rodarNo("Invoice ausente no relatório ML", {
    input: { referencia: "105/2", numero: 105, serie: 2, executionId: EXEC },
    run,
  });
  const novo = itemInvoiceAusente({ numero: 105, serie: 2 }, EXEC);
  assert.equal(novo.mensagem, oldInv.mensagem);
  assert.equal(novo.diagnostico, run.lote[0].diagnostico);
});

const passo = (id: string, status: "ok" | "erro" | "info", titulo = id, detalhe = "") => ({ id, titulo, status, detalhe });
const lote: ItemLote[] = [
  { referencia: "101/2", numero: 101, serie: 2, invoiceId: "i1", chave: "k1", proximaAcao: "contigencia", diagnostico: "ML não avisou.",
    passos: [passo("notificacao", "erro", "Aviso do ML", "sem linha"), passo("invoice", "info", "Nota no Nerus"), passo("contigencia", "ok")],
    contigencia: { notificationId: "n-1", httpStatus: 200 } },
  { referencia: "102/2", numero: 102, serie: 2, invoiceId: "i2", proximaAcao: "esperar_entrega", diagnostico: "Envio pendente.",
    passos: [passo("notificacao", "ok", "Aviso do ML"), passo("entrega", "info", "Envio FTP", "PENDING")],
    rastro: [{ n: 1, tabela: "notification_control", executado: true, filtro: "x = 1", linhas: 1, detalhe: "" },
             { n: 2, tabela: "fiscal_document_deliveries", executado: false, filtro: "", linhas: 0, detalhe: "pulado" }] },
  { referencia: "103/2", numero: 103, serie: 2, invoiceId: "i3", proximaAcao: "rechecar_ftp", diagnostico: "Já enviado." },
  { referencia: "104/2", numero: 104, serie: 2, invoiceId: "i4", proximaAcao: "nenhuma", diagnostico: "Falhou.",
    passos: [passo("contigencia", "erro", "Contingência", "HTTP 500")] },
  itemInvoiceAusente({ numero: 105, serie: 2 }, EXEC),
];

test("paridade: relatório de cada NF do lote (resolvida e ainda ausente)", pular, async () => {
  const notas = lote.map(({ numero, serie }) => ({ numero, serie }));
  for (const ausentesAgora of [[], [{ numero: 101, serie: 2 }, { numero: 104, serie: 2 }], notas]) {
    const old = await rodarNo("Montar relatórios do lote", {
      input: { notasAusentes: ausentesAgora },
      nodes: { "Montar resumo da checagem": { notasAusentes: notas } },
      run: { lote: structuredClone(lote) },
    });
    const novo = lote.map((i) => relatorioNota(i, ausentesAgora, EXEC));
    assert.deepEqual(novo.map((r) => [r.assunto, r.mensagem]), old.map((r) => [r.assunto, r.mensagem]));
  }
});

test("paridade: resumo da conferência do lote", pular, async () => {
  const n = (numero: number) => ({ numero, serie: 2 });
  for (const [originais, ausentes] of [[[], []], [[n(1), n(2)], []], [[n(1), n(2), n(3)], [n(2)]], [[n(1)], [n(1)]]]) {
    const [old] = await rodarNo("Relatório de conferência do lote", {
      input: { notasAusentes: ausentes },
      nodes: { "Montar resumo da checagem": { notasAusentes: originais } },
    });
    const novo = relatorioConferencia(originais, ausentes, EXEC);
    assert.deepEqual([novo.assunto, novo.mensagem, novo.noFtp], [old.assunto, old.mensagem, old.noFtp]);
  }
});

test("paridade: espera do lote", pular, async () => {
  for (const acoes of [[], ["nenhuma"], ["contigencia", "nenhuma"], ["contigencia", "esperar_entrega"], ["rechecar_ftp"]] as const) {
    const [old] = await rodarNo("Decidir espera do lote", { input: {}, run: { lote: acoes.map((proximaAcao) => ({ proximaAcao })) } });
    assert.equal(decidirEsperaLote([...acoes]), old.espera);
  }
});
