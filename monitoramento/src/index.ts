import cron from "node-cron";
import { carregarConfig } from "./config.js";
import { iniciarHttp, intervaloPainelMin } from "./http.js";
import { executarJob, jobOcupado, retomarHistorico } from "./job.js";
import { contingenciaLigada } from "./ciclo.js";
import { canaisDoAmbiente } from "./avisos.js";
import { configurarAgenda, depsOrquestradorReais, dispararCiclo, modoAgenda } from "./orquestrador.js";

const AGENDA_PADRAO = "0 8-18 * * 1-5"; // seg–sex, de hora em hora, 8h–18h (o mesmo cron do workflow n8n)

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

/** MODO_AGENDA: off (o n8n agenda) · sombra (roda sem contingência e sem enviar avisos) · ativo (substitui o n8n). */
function iniciarAgenda(config: ReturnType<typeof carregarConfig>): void {
  const modo = modoAgenda();
  if (modo === "off") {
    console.log("▶ Agenda do ciclo desligada (MODO_AGENDA=off): quem agenda é o n8n");
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
  console.log(
    sombra
      ? `▶ Agenda do ciclo em SOMBRA (${expressao}): roda sem contingência e não envia avisos`
      : `▶ Agenda do ciclo ATIVA (${expressao}): o monitor agenda, espera e avisa (desative o workflow do n8n)`,
  );
  if (!sombra && !canaisDoAmbiente().length) {
    console.warn("▶ ATENÇÃO: nenhum canal de aviso configurado (GOOGLE_CHAT_WEBHOOK_URL, WHATSAPP_WEBHOOK_URL, SMTP_HOST + ALERT_EMAIL_TO)");
  }
}

main();
