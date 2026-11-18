import { carregarConfig } from "./config.js";
import { iniciarHttp, intervaloPainelMin } from "./http.js";
import { executarJob, jobOcupado, retomarHistorico } from "./job.js";

function main(): void {
  const config = carregarConfig();
  retomarHistorico();
  iniciarHttp(config);

  // Painel: checagem silenciosa — quem agenda o ciclo e avisa é o n8n (POST /ciclo).
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

main();
