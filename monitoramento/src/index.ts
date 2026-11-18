import cron from "node-cron";
import { carregarConfig } from "./config.js";
import { iniciarHttp, intervaloPainelMin } from "./http.js";
import { executarJob, jobOcupado, retomarHistorico } from "./job.js";

function formatarProxima(data: Date | null): string {
  if (!data) return "(sem próxima)";
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(data);
}

async function main(): Promise<void> {
  const config = carregarConfig();
  retomarHistorico();
  iniciarHttp(config);

  if (config.executar_ao_iniciar) {
    await executarJob(config);
  }

  // Painel: checagem silenciosa (sem webhook) — quem avisa é o n8n.
  const intervalo = intervaloPainelMin();
  if (intervalo) {
    const checarPainel = () => {
      if (jobOcupado()) return;
      executarJob(config, { notificar: false }).catch((erro) =>
        console.error(`▶ Checagem do painel falhou: ${erro instanceof Error ? erro.message : String(erro)}`),
      );
    };
    if (!config.executar_ao_iniciar) checarPainel();
    setInterval(checarPainel, intervalo * 60_000);
    console.log(`▶ Painel: checagem a cada ${intervalo} min`);
  }

  if (!config.agendamento) {
    return;
  }

  if (!cron.validate(config.agendamento)) {
    throw new Error(`agendamento cron inválido: ${config.agendamento}`);
  }

  const tarefa = cron.schedule(
    config.agendamento,
    () => {
      executarJob(config)
        .catch((erro) => {
          console.error("Falha na execução agendada:", erro);
        });
    },
    { timezone: "America/Sao_Paulo", noOverlap: true, name: "monitor-sftp" },
  );

  const proximas = tarefa.getNextRuns(4);
  console.log(`Agendado: ${config.agendamento} (America/Sao_Paulo)`);
  console.log(`Próximas execuções: ${proximas.map((d) => formatarProxima(d)).join(" · ")}`);
  if (!config.executar_ao_iniciar) {
    console.log("Aguardando o horário da cron (não executa na subida).");
  }
}

main().catch((erro) => {
  console.error(erro);
  process.exit(1);
});
