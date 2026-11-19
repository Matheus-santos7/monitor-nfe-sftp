// Mensagens para o Google Chat: versão curta dos relatórios (o detalhe técnico fica no painel) e o resumo
// do período (10h e 18h), no lugar do "100% OK" de toda hora.
import { diaDe, lerDia, type DiaHistorico } from "./historico.js";
import type { Mensagem } from "./relatorio.js";

/** Link do painel para os avisos (só com DNS real; em desenvolvimento, *.localhost, não há link útil). */
export function linkPainel(painelHost = process.env.PAINEL_HOST): string | null {
  const h = painelHost?.trim();
  return h && !h.endsWith("localhost") ? `https://${h}` : null;
}

/** Chat: título em negrito, sem o "Rastro técnico" (tabelas, ids) e com o link do painel no fim. */
export function paraChat(m: Mensagem, link = linkPainel()): Mensagem {
  const corte = m.mensagem.search(/^\s*Rastro técnico\s*$/m);
  const corpo = (corte >= 0 ? m.mensagem.slice(0, corte) : m.mensagem).replace(/\n{3,}/g, "\n\n").trim();
  return { assunto: m.assunto, mensagem: `*${m.assunto}*\n\n${corpo}${link ? `\n\nDetalhes: ${link}` : ""}` };
}

/**
 * Decide se a mensagem do ciclo vai para o Chat, para o canal não virar ruído:
 * - ok: só quando VOLTA ao normal (antes havia furo, falha ou cobertura parcial);
 * - degradado (cobertura parcial): só quando muda de estado;
 * - em_transito: nada (ainda dentro da tolerância);
 * - alerta/falhou: sempre (são os avisos que importam).
 */
export function deveAvisar(status: string, anterior: string | null): boolean {
  if (status === "alerta" || status === "falhou") return true;
  if (status === "degradado") return anterior !== "degradado";
  if (status === "ok") return anterior !== null && anterior !== "ok" && anterior !== "em_transito";
  return false;
}

const HORA_MANHA = 10;
const HORA_TARDE = 18;
const horaSp = (d: Date) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }).format(d));
// 00:00 em São Paulo (UTC-3; o Brasil não tem horário de verão desde 2019)
const meiaNoiteSp = (d: Date) => {
  const [a, m, dd] = (diaDe(d).match(/(\d{4})(\d{2})(\d{2})/) ?? []).slice(1).map(Number);
  return Date.UTC(a, m - 1, dd, 3, 0, 0);
};

/** Início do período: às 10h, desde as 18h do dia útil anterior (segunda: desde sexta 18h); às 18h, desde as 10h. */
export function inicioPeriodo(agora: Date): Date {
  if (horaSp(agora) >= HORA_TARDE) return new Date(meiaNoiteSp(agora) + HORA_MANHA * 3_600_000);
  let ontem = meiaNoiteSp(agora) - 86_400_000;
  while ([0, 6].includes(new Date(ontem + 12 * 3_600_000).getUTCDay())) ontem -= 86_400_000; // pula sábado e domingo
  return new Date(ontem + HORA_TARDE * 3_600_000);
}

const dataHora = (d: Date) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);

/** Resumo de um período a partir dos dias do histórico (função pura). */
export function resumoPeriodo(
  dias: DiaHistorico[],
  inicio: Date,
  fim: Date,
  abertosAgora: Record<string, string>,
  identificador: string,
  link = linkPainel(),
): Mensagem {
  const ev = dias
    .flatMap((d) => d.eventos)
    .filter((e) => {
      const t = new Date(e.em).getTime();
      return t >= inicio.getTime() && t < fim.getTime();
    });
  const conta = (tipo: string) => ev.filter((e) => e.tipo === tipo).length;
  const dur = ev.filter((e) => e.tipo === "furo_resolvido").map((e) => e.duracaoMin ?? 0);
  const idades = Object.values(abertosAgora).map((iso) => Math.floor((fim.getTime() - new Date(iso).getTime()) / 60_000));
  const falhas = conta("checagem_falhou");
  const linhas = [
    `${idades.length || falhas ? "⚠️" : "✅"} *Resumo do monitoramento* — ${identificador}`,
    `Período: ${dataHora(inicio)} → ${dataHora(fim)}`,
    "",
    `• Notas que faltaram no FTP: ${conta("furo_aberto")}`,
    `• Chegaram depois: ${dur.length}${dur.length ? ` (média ${Math.round(dur.reduce((a, b) => a + b, 0) / dur.length)} min, pior ${Math.max(...dur)} min)` : ""}`,
    `• Ainda faltando agora: ${idades.length}${idades.length ? ` (a mais antiga há ${Math.max(...idades)} min)` : ""}`,
    `• Falhas de checagem: ${falhas}`,
  ];
  if (!ev.length && !idades.length) linhas.push("", "Nenhuma ocorrência no período.");
  if (link) linhas.push("", `Painel: ${link}`);
  return { assunto: `Resumo do monitoramento — ${identificador}`, mensagem: linhas.join("\n") };
}

/** Os dias do histórico que o período cobre. */
export function diasDoPeriodo(inicio: Date, fim: Date, ler: (dia: string) => DiaHistorico | null = lerDia): DiaHistorico[] {
  const vistos = new Set<string>();
  const dias: DiaHistorico[] = [];
  for (let t = inicio.getTime(); t < fim.getTime() + 86_400_000; t += 86_400_000) {
    const dia = diaDe(new Date(Math.min(t, fim.getTime())));
    if (vistos.has(dia)) continue;
    vistos.add(dia);
    const d = ler(dia);
    if (d) dias.push(d);
  }
  return dias;
}
