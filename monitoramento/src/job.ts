import { carregarConfig, identificadorCliente } from "./config.js";
import { analisarSeries, aplicarFakeNota, expandirNotas, integracaoCompleta } from "./gaps.js";
import { listarArquivosFtp } from "./sftp.js";
import { enviarWebhooks, montarEventoPainel, montarPayload } from "./webhook.js";
import { credenciaisMlConfiguradas } from "./ml-auth.js";
import { buscarTetosPorSerie } from "./ml-invoices.js";
import { persistirExecucao } from "./db.js";
import type { AppConfig, ResultadoSerie, TetoMl } from "./types.js";

export type ResultadoJob = {
  identificador: string;
  series: ResultadoSerie[];
  integracaoOk: boolean;
  notasAusentes: { numero: number; serie: number }[];
  tetoPeriodo?: { start: string; end: string } | null;
};

let emAndamento = false;

export function jobOcupado(): boolean {
  return emAndamento;
}

export async function executarJob(
  config?: AppConfig,
  opcoes?: { notificar?: boolean },
): Promise<ResultadoJob | "ocupado"> {
  if (emAndamento) return "ocupado";
  emAndamento = true;
  const cfg = config ?? carregarConfig();
  const notificar = opcoes?.notificar !== false;

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
        console.warn(`   Teto ML indisponível: ${erro instanceof Error ? erro.message : String(erro)}`);
      }
    } else {
      console.warn("   Credenciais ML ausentes — teto usa só o FTP");
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

    if (notificar) {
      await enviarWebhooks(cfg, montarPayload(cfg, resultados), montarEventoPainel(cfg, resultados));
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

    const resultado: ResultadoJob = {
      identificador,
      series: resultados,
      integracaoOk: forcado.integracaoOk,
      notasAusentes: forcado.notasAusentes,
      tetoPeriodo: janelaTeto,
    };
    // persistirExecucao já engole os próprios erros: histórico nunca derruba a checagem.
    await persistirExecucao(resultado);
    return resultado;
  } finally {
    emAndamento = false;
  }
}
