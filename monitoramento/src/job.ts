import { carregarConfig, identificadorCliente } from "./config.js";
import { analisarSeries, aplicarFakeNota, expandirNotas, integracaoCompleta } from "./gaps.js";
import { listarArquivosFtp } from "./sftp.js";
import { credenciaisMlConfiguradas } from "./ml-auth.js";
import { buscarTetosPorSerie } from "./ml-invoices.js";
import type { AppConfig, ResultadoSerie, TetoMl } from "./types.js";
import { diaDe, diaVazio, lerDia, salvarDia, ultimoDiaGravado, type DiaHistorico, type EventoHistorico } from "./historico.js";

export type ResultadoJob = {
  identificador: string;
  series: ResultadoSerie[];
  integracaoOk: boolean;
  notasAusentes: { numero: number; serie: number }[];
  tetoPeriodo?: { start: string; end: string } | null;
  avisos: string[];
};

export type StatusPainel = {
  checadoEm: string | null;
  duracaoMs: number | null;
  /** ok = sem furo e sem aviso; alerta = furo; erro = checagem falhou ou ficou cega (ex.: sem teto ML). */
  status: "ok" | "alerta" | "erro" | "aguardando";
  erro: string | null;
  avisos: string[];
  resultado: ResultadoJob | null;
  /** "numero/serie" → ISO da primeira checagem em que o furo apareceu. */
  ausentesDesde: Record<string, string>;
};

let emAndamento = false;
let fila: Promise<unknown> = Promise.resolve();
const ausentesDesde = new Map<string, string>();
const painel: StatusPainel = {
  checadoEm: null,
  duracaoMs: null,
  status: "aguardando",
  erro: null,
  avisos: [],
  resultado: null,
  ausentesDesde: {},
};

export function jobOcupado(): boolean {
  return emAndamento;
}

export function statusPainel(): StatusPainel {
  return painel;
}

/** Atualiza o painel e o histórico do dia; mantém a hora do primeiro aparecimento de cada furo. */
export function registrarChecagem(
  inicio: number,
  saida: { resultado: ResultadoJob; avisos: string[] } | { erro: string },
  agora = new Date(),
): void {
  const em = agora.toISOString();
  const d = diaAtual(agora);
  const evento = (e: Omit<EventoHistorico, "em">) => d.eventos.push({ em, ...e });
  painel.checadoEm = em;
  painel.duracaoMs = agora.getTime() - inicio;
  d.checagens.total++;
  d.primeiraEm ??= em;
  d.ultimaEm = em;

  if ("erro" in saida) {
    // falha de SFTP etc.: mantém o último resultado e a idade dos furos
    if (painel.erro !== saida.erro) evento({ tipo: "checagem_falhou", texto: saida.erro });
    painel.status = "erro";
    painel.erro = saida.erro;
    d.checagens.erro++;
    salvar(d);
    return;
  }

  if (painel.erro) evento({ tipo: "checagem_voltou", texto: "Checagem voltou a funcionar" });
  for (const a of saida.avisos) if (!painel.avisos.includes(a)) evento({ tipo: "aviso", texto: a });
  const atuais = new Set(saida.resultado.notasAusentes.map((n) => `${n.numero}/${n.serie}`));
  for (const [k, desde] of ausentesDesde) {
    if (atuais.has(k)) continue;
    const duracaoMin = Math.round((agora.getTime() - new Date(desde).getTime()) / 60000);
    evento({ tipo: "furo_resolvido", nota: k, duracaoMin, texto: `NF ${k} chegou ao FTP após ${duracaoMin} min` });
    ausentesDesde.delete(k);
  }
  for (const k of atuais) {
    if (ausentesDesde.has(k)) continue;
    ausentesDesde.set(k, em);
    evento({ tipo: "furo_aberto", nota: k, texto: `NF ${k} ausente no FTP` });
  }
  painel.erro = null;
  painel.avisos = saida.avisos;
  painel.resultado = saida.resultado;
  painel.ausentesDesde = Object.fromEntries(ausentesDesde);
  painel.status = !saida.resultado.integracaoOk ? "alerta" : saida.avisos.length ? "erro" : "ok";
  d.checagens[painel.status === "ok" ? "ok" : painel.status === "alerta" ? "alerta" : "erro"]++;
  d.abertos = painel.ausentesDesde;
  salvar(d);
}

/** Evento avulso no histórico do dia (ex.: aviso que nenhum canal entregou). */
export function registrarEventoAviso(texto: string, agora = new Date()): void {
  const d = diaAtual(agora);
  d.eventos.push({ em: agora.toISOString(), tipo: "aviso", texto });
  salvar(d);
}

let hoje: DiaHistorico | null = null;

/** Troca de arquivo à meia-noite (SP); furos abertos passam para o dia novo. */
function diaAtual(agora: Date): DiaHistorico {
  const dia = diaDe(agora);
  if (hoje?.dia !== dia) hoje = lerDia(dia) ?? diaVazio(dia, Object.fromEntries(ausentesDesde));
  return hoje;
}

function salvar(d: DiaHistorico): void {
  try {
    salvarDia(d);
  } catch (erro) {
    const msg = `Histórico não gravado: ${erro instanceof Error ? erro.message : String(erro)}`;
    console.error(`▶ ${msg}`);
    // Aparece no painel: sem isso os KPIs do dia congelam e seguem "Saudável".
    painel.avisos = [...painel.avisos, msg];
    if (painel.status === "ok") painel.status = "erro";
  }
}

/** Na subida: retoma os furos em aberto do último dia gravado, para não reabri-los no histórico. */
export function retomarHistorico(): void {
  const ultimo = ultimoDiaGravado();
  if (!ultimo) return;
  for (const [k, desde] of Object.entries(ultimo.abertos)) ausentesDesde.set(k, desde);
  painel.ausentesDesde = Object.fromEntries(ausentesDesde);
}

/** Serializa as checagens: quem chega com outra em curso espera ela terminar (ciclo agendado + loop do painel). */
export function executarJob(config?: AppConfig): Promise<ResultadoJob> {
  const rodada = fila.then(() => rodarJob(config));
  fila = rodada.catch(() => undefined);
  return rodada;
}

async function rodarJob(config?: AppConfig): Promise<ResultadoJob> {
  emAndamento = true;
  const inicio = Date.now();
  const avisos: string[] = [];
  const cfg = config ?? carregarConfig();

  try {
    const identificador = identificadorCliente(cfg);
    console.log(`   ${identificador}`);
    console.log(`   SFTP ${cfg.sftp.host}:${cfg.sftp.porta}`);
    const arquivos = await listarArquivosFtp(cfg);

    let tetos = new Map<number, TetoMl>();
    let janelaTeto: { start: string; end: string } | null = null;
    if (credenciaisMlConfiguradas()) {
      try {
        const rel = await buscarTetosPorSerie(cfg.series.map((s) => s.numero));
        tetos = rel.tetos;
        janelaTeto = { start: rel.start, end: rel.end };
        const resumo = cfg.series
          .map((s) => {
            const t = tetos.get(s.numero);
            return t ? `série ${s.numero} teto ML ${t.numero} (invoice ${t.invoiceId})` : `série ${s.numero} sem emissão no período`;
          })
          .join("; ");
        console.log(`   Teto ML ${rel.start}–${rel.end}: ${resumo}`);
      } catch (erro) {
        const msg = `Teto ML indisponível: ${erro instanceof Error ? erro.message : String(erro)}`;
        console.warn(`   ${msg}`);
        avisos.push(`${msg} — furos no fim da sequência ficam invisíveis`);
      }
    } else {
      console.warn("   Credenciais ML ausentes — teto usa só o FTP");
      avisos.push("Credenciais ML ausentes — teto usa só o FTP");
    }

    const resultados = analisarSeries(arquivos, cfg.series, tetos);

    for (const r of resultados) {
      if (r.totalAusentes === -1) {
        console.log(`   Série ${r.serie}: nenhum XML encontrado`);
      } else if (r.totalAusentes === 0) {
        console.log(`   Série ${r.serie}: ok (${r.total} XMLs, FTP ${r.min} → ${r.max}${r.tetoMl ? `, teto ML ${r.tetoMl}` : ""})`);
      } else {
        console.log(
          `   Série ${r.serie}: ${r.totalAusentes} nota(s) faltando` +
            (r.ultimaMlNoFtp === false ? ` (última ML ${r.tetoMl} ausente no FTP)` : ""),
        );
      }
    }

    const forcado = aplicarFakeNota(
      expandirNotas(resultados),
      integracaoCompleta(resultados),
      process.env.FAKE_NOTA,
    );
    if (forcado.fake) {
      console.warn(
        `   FAKE_NOTA: forçando furo ${forcado.fake.numero}/${forcado.fake.serie}`,
      );
    }

    for (const r of resultados) if (r.totalAusentes === -1) avisos.push(`Série ${r.serie}: nenhum XML no FTP`);

    const resultado: ResultadoJob = {
      identificador,
      series: resultados,
      integracaoOk: forcado.integracaoOk,
      notasAusentes: forcado.notasAusentes,
      tetoPeriodo: janelaTeto,
      avisos,
    };
    registrarChecagem(inicio, { resultado, avisos });
    return resultado;
  } catch (erro) {
    registrarChecagem(inicio, { erro: erro instanceof Error ? erro.message : String(erro) });
    throw erro;
  } finally {
    emAndamento = false;
  }
}
