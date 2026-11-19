// Importa o histórico JSON (data/historico/AAAAMMDD.json) para o MySQL (sqlmonitoramento.monitor_evento).
// Idempotente (INSERT IGNORE pela chave cliente+em+tipo+nota): pode rodar de novo sem duplicar.
//   docker compose exec api node dist/migrar-historico.js "<identificador do cliente>"
import { bancoConfigurado, bancoEventos, esperarBanco, iniciarBanco, avisosBanco } from "./db.js";
import { lerDia, listarDias } from "./historico.js";

async function main(): Promise<void> {
  const cliente = process.argv[2]?.trim();
  if (!cliente) throw new Error('uso: node dist/migrar-historico.js "<identificador do cliente>" (o mesmo do painel)');
  if (!bancoConfigurado()) throw new Error("defina DB_HOST, DB_USER, DB_PASSWORD (e DB_NAME) no ambiente");
  await iniciarBanco();
  let total = 0;
  for (const dia of listarDias().reverse()) {
    const d = lerDia(dia);
    if (!d?.eventos.length) continue;
    bancoEventos(cliente, d.eventos);
    total += d.eventos.length;
    console.log(`  ${dia}: ${d.eventos.length} evento(s)`);
  }
  await esperarBanco();
  const erro = avisosBanco();
  if (erro.length) throw new Error(erro[0]);
  console.log(`▶ Migração concluída: ${total} evento(s) enviados (repetidos são ignorados).`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
