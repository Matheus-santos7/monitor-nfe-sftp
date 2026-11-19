import cron from "node-cron";
import { carregarConfig } from "./config.js";
import { iniciarHttp, intervaloPainelMin } from "./http.js";
import { executarJob, jobOcupado, retomarHistorico } from "./job.js";
import { contingenciaLigada } from "./ciclo.js";
import { canaisDoAmbiente } from "./avisos.js";
import { configurarAgenda, depsOrquestradorReais, dispararCiclo, modoAgenda } from "./orquestrador.js";
import { statusPainel } from "./job.js";
import { diasDoPeriodo, inicioPeriodo, resumoPeriodo } from "./resumo.js";

const AGENDA_PADRAO = "0 8-18 * * 1-5"; // seg–sex, de hora em hora, 8h–18h

function main(): void {
  const config = carregarConfig();
  retomarHistorico();
  iniciarHttp(config);
  console.log(
    contingenciaLigada()
      ? "▶ Contingência LIGADA: o ciclo renotifica o gateway fiscal de verdade"
      : "▶ Contingência desligada (CONTINGENCIA≠on): o ciclo só diagnostica",
  );
  iniciarAgenda(config);

  // Painel: checagem silenciosa, sem diagnóstico e sem aviso.
  const intervalo = intervaloPainelMin();
  if (!intervalo) return;
  const checarPainel = () => {
    if (jobOcupado()) return;
    executarJob(config).catch((erro) =>
      console.error(`▶ Checagem do painel falhou: ${erro instanceof Error ? erro.message : String(erro)}`),
    );
  };
  checarPainel();
  setInterval(checarPainel, intervalo * 60_000);
  console.log(`▶ Painel: checagem a cada ${intervalo} min`);
}

/** MODO_AGENDA: off (pausado) · sombra (roda sem contingência e sem enviar avisos) · ativo (produção). */
function iniciarAgenda(config: ReturnType<typeof carregarConfig>): void {
  const modo = modoAgenda();
  if (modo === "off") {
    console.log("▶ Agenda do ciclo desligada (MODO_AGENDA=off): o monitor só serve o painel");
    return;
  }
  const expressao = process.env.AGENDA_CICLO?.trim() || AGENDA_PADRAO;
  if (!cron.validate(expressao)) throw new Error(`AGENDA_CICLO inválida: ${expressao}`);
  const deps = depsOrquestradorReais(config);
  const sombra = modo === "sombra";
  const tarefa = cron.schedule(expressao, () => void dispararCiclo(deps, { origem: "agenda", sombra }), {
    timezone: "America/Sao_Paulo",
    name: "ciclo",
  });
  configurarAgenda({ modo, expressao, proximo: () => tarefa.getNextRun() });

  // Resumo do período no Chat (padrão 10h e 18h, dias úteis): às 10h cobre desde as 18h do dia útil anterior.
  const cronResumo = process.env.RESUMO_CRON?.trim() || "0 10,18 * * 1-5";
  if (!cron.validate(cronResumo)) throw new Error(`RESUMO_CRON inválida: ${cronResumo}`);
  cron.schedule(
    cronResumo,
    () => {
      const agora = new Date();
      const inicio = inicioPeriodo(agora);
      const p = statusPainel();
      const m = resumoPeriodo(diasDoPeriodo(inicio, agora), inicio, agora, p.ausentesDesde, p.resultado?.identificador ?? config.cliente.nome);
      if (sombra) return console.log(`▶ [sombra] resumo não enviado: ${m.assunto}`);
      deps
        .enviar(m)
        .then((r) => console.log(`▶ Resumo do período enviado (${r.entregues.join(", ") || "nenhum canal"})`))
        .catch((e) => console.error(`▶ Resumo do período falhou: ${e instanceof Error ? e.message : String(e)}`));
    },
    { timezone: "America/Sao_Paulo", name: "resumo" },
  );
  console.log(`▶ Resumo do período: ${cronResumo} (America/Sao_Paulo)`);
  console.log(
    sombra
      ? `▶ Agenda do ciclo em SOMBRA (${expressao}): roda sem contingência e não envia avisos`
      : `▶ Agenda do ciclo ATIVA (${expressao}): o monitor agenda, espera e avisa`,
  );
  if (!sombra && !canaisDoAmbiente().length) {
    console.warn("▶ ATENÇÃO: nenhum canal de aviso configurado (GOOGLE_CHAT_WEBHOOK_URL, WHATSAPP_WEBHOOK_URL, SMTP_HOST + ALERT_EMAIL_TO)");
  }
}

main();
