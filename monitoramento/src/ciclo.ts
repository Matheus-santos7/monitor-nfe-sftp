// Regra do ciclo: checar → diagnosticar cada NF ausente → decidir a espera do lote → conferir no FTP.
// Quem agenda, espera e envia `mensagens` é o orquestrador.ts. Stateless: o lote é passado de volta para conferirLote.
import type { AppConfig } from "./types.js";
import { executarJob, type ResultadoJob } from "./job.js";
import { localizarInvoicePorNf, validarUsuarioMl } from "./ml-invoices.js";
import { diagnosticarNota } from "./diagnostico.js";
import { parseFakeNota } from "./gaps.js";
import { comSessaoNerus } from "./nerus-db.js";
import {
  decidirEsperaLote,
  horarioSaoPaulo,
  itemInvoiceAusente,
  mensagemResumo,
  mensagemSerieSemXml,
  relatorioConferencia,
  relatorioNota,
  type ItemLote,
  type Mensagem,
} from "./relatorio.js";

type Nota = { numero: number; serie: number };

export type DepsCiclo = {
  checar: () => Promise<ResultadoJob>;
  validarMl: () => Promise<{ id: number }>;
  localizar: (n: Nota) => Promise<{ encontrado: boolean; invoiceId?: string; chave?: string }>;
  diagnosticar: typeof diagnosticarNota;
};

export function depsReais(cfg: AppConfig): DepsCiclo {
  return {
    checar: () => executarJob(cfg),
    validarMl: validarUsuarioMl,
    localizar: (n) => localizarInvoicePorNf(n),
    diagnosticar: diagnosticarNota,
  };
}

/**
 * Só renotifica o gateway com CONTINGENCIA=on explícito (só o docker-compose.prod.yml liga).
 * Vazio, ausente ou qualquer outro valor = desligado: rodar local com credencial real não age em produção.
 */
export function contingenciaLigada(): boolean {
  return /^(on|true|1|yes|sim)$/i.test(process.env.CONTINGENCIA?.trim() ?? "");
}

export type ResultadoCiclo = {
  /** ok = tudo integrado e checagem completa; degradado = sem furo visível, mas checagem cega (ex.: sem teto ML); alerta = furo. */
  status: "ok" | "degradado" | "alerta";
  identificador: string;
  avisos: string[];
  notasAusentes: Nota[];
  lote: ItemLote[];
  espera: "10min" | "2min" | "nenhuma";
  /** Avisos para enviar já neste passo (resumo ok/degradado ou série sem XML). Vazio quando há lote a conferir. */
  mensagens: Mensagem[];
};

/** `contingencia: false` força só diagnóstico (modo sombra da agenda), mesmo com CONTINGENCIA=on. */
export async function rodarCiclo(
  deps: DepsCiclo,
  execucao: string,
  agora = new Date(),
  opcoes: { contingencia?: boolean } = {},
): Promise<ResultadoCiclo> {
  const contingencia = (opcoes.contingencia ?? true) && contingenciaLigada();
  const r = await deps.checar();
  const status = !r.integracaoOk ? "alerta" : r.avisos.length ? "degradado" : "ok";
  const base = { status, identificador: r.identificador, avisos: r.avisos, notasAusentes: r.notasAusentes } as const;
  const fim = (extra: Pick<ResultadoCiclo, "lote" | "espera" | "mensagens">): ResultadoCiclo => ({ ...base, ...extra });

  if (status !== "alerta") {
    const resumo = mensagemResumo({ ...r, fake: Boolean(parseFakeNota(process.env.FAKE_NOTA)), horario: horarioSaoPaulo(agora) });
    return fim({ lote: [], espera: "nenhuma", mensagens: [resumo] });
  }

  const me = await deps.validarMl(); // falha aqui = token ML inválido → o ciclo falha e quem chamou avisa (aviso de falha)
  if (!r.notasAusentes.length) {
    return fim({ lote: [], espera: "nenhuma", mensagens: [mensagemSerieSemXml(r.identificador, execucao)] });
  }

  const lote: ItemLote[] = [];
  await comSessaoNerus(async () => {
    for (const nota of r.notasAusentes) lote.push(await diagnosticarItem(deps, nota, String(me.id), execucao, contingencia));
  });
  return fim({ lote, espera: decidirEsperaLote(lote.map((i) => i.proximaAcao)), mensagens: [] });
}

async function diagnosticarItem(deps: DepsCiclo, nota: Nota, mlUserId: string, execucao: string, contingencia: boolean): Promise<ItemLote> {
  const referencia = `${nota.numero}/${nota.serie}`;
  let loc: Awaited<ReturnType<DepsCiclo["localizar"]>>;
  try {
    loc = await deps.localizar(nota);
  } catch (erro) {
    // Falha da API do ML ≠ "nota não está no relatório": diz que a consulta falhou e pede o time técnico.
    const motivo = erro instanceof Error ? erro.message : String(erro);
    console.error(`▶ Localizar NF ${referencia} no ML falhou: ${motivo}`);
    return {
      referencia,
      numero: nota.numero,
      serie: nota.serie,
      invoiceId: null,
      proximaAcao: "nenhuma",
      diagnostico: `Não foi possível consultar o Mercado Livre: ${motivo}`,
    };
  }
  if (!loc.encontrado || !loc.invoiceId) return itemInvoiceAusente(nota, execucao);
  try {
    const d = await deps.diagnosticar({
      invoiceId: loc.invoiceId,
      chave: loc.chave ?? null,
      numero: nota.numero,
      serie: nota.serie,
      mlUserId,
      executarContigencia: contingencia,
    });
    return {
      referencia: d.referencia,
      numero: d.numero,
      serie: d.serie,
      invoiceId: d.invoiceId,
      chave: d.chave,
      proximaAcao: d.proximaAcao,
      diagnostico: d.diagnostico,
      passos: d.passos,
      contigencia: d.contigencia ?? null,
      rastro: d.rastro,
      mensagem: d.mensagem,
    };
  } catch (erro) {
    // Falha numa NF não derruba o ciclo: ela segue no lote e o relatório pede o time técnico.
    console.error(`▶ Diagnóstico da NF ${referencia} falhou: ${erro instanceof Error ? erro.message : String(erro)}`);
    return {
      referencia,
      numero: nota.numero,
      serie: nota.serie,
      invoiceId: loc.invoiceId,
      chave: loc.chave ?? null,
      proximaAcao: "nenhuma",
      diagnostico: `Não foi possível consultar o Nerus: ${erro instanceof Error ? erro.message : String(erro)}`,
    };
  }
}

export type ResultadoConferencia = {
  aindaFaltam: boolean;
  faltando: Nota[];
  noFtp: number;
  total: number;
  /** Um relatório por NF do lote + o resumo do lote. Enviar só na última conferência. */
  mensagens: Mensagem[];
};

export async function conferirLote(
  deps: Pick<DepsCiclo, "checar">,
  entrada: { notas: Nota[]; lote: ItemLote[]; execucao: string },
): Promise<ResultadoConferencia> {
  const { notas, lote, execucao } = entrada;
  const r = await deps.checar();
  const conf = relatorioConferencia(notas, r.notasAusentes, execucao);
  const itens: ItemLote[] = lote.length
    ? lote
    : notas.map((n) => ({
        numero: n.numero,
        serie: n.serie,
        referencia: `${n.numero}/${n.serie}`,
        invoiceId: null,
        proximaAcao: "nenhuma",
        diagnostico: "Diagnóstico não gravado neste ciclo.",
      }));
  const relatorios = itens.map((i) => relatorioNota(i, r.notasAusentes, execucao));
  return {
    aindaFaltam: conf.faltando.length > 0,
    faltando: conf.faltando,
    noFtp: conf.noFtp,
    total: conf.total,
    mensagens: [...relatorios.map(({ assunto, mensagem }) => ({ assunto, mensagem })), { assunto: conf.assunto, mensagem: conf.mensagem }],
  };
}
