import cron from "node-cron";
import { carregarConfig } from "./config.js";
import { iniciarHttp } from "./http.js";
import { executarJob } from "./job.js";

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
  iniciarHttp(config);

  if (config.executar_ao_iniciar) {
    const resultado = await executarJob(config);
    if (resultado === "ocupado") {
      console.warn("▶ Checagem inicial ignorada: já em andamento.");
    }
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
        .then((resultado) => {
          if (resultado === "ocupado") {
            console.warn("Cron pulada: já existe uma checagem em andamento.");
          }
        })
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
