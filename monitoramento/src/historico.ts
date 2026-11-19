import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { yyyymmddEmTz } from "./ml-invoices.js";

export type EventoHistorico = {
  em: string;
  tipo: "furo_aberto" | "furo_resolvido" | "checagem_falhou" | "checagem_voltou" | "aviso";
  texto: string;
  nota?: string;
  duracaoMin?: number;
};

export type DiaHistorico = {
  dia: string; // AAAAMMDD em America/Sao_Paulo
  checagens: { total: number; ok: number; alerta: number; erro: number };
  primeiraEm: string | null;
  ultimaEm: string | null;
  eventos: EventoHistorico[];
  /** Furos em aberto ao fim da última checagem ("numero/serie" → ISO de quando apareceu). */
  abertos: Record<string, string>;
};

export type ResumoDia = {
  nivel: "saudavel" | "atencao" | "critico" | "sem_dados";
  /** % das checagens do dia que terminaram ok. */
  saudePct: number | null;
  furosAbertos: number;
  furosResolvidos: number;
  resolucaoMediaMin: number | null;
  resolucaoMaxMin: number | null;
  abertosAgora: number;
  maisAntigoMin: number | null;
  falhasChecagem: number;
};

const CRITICO_MIN = 60; // furo aberto há mais de 1 h = cliente provavelmente já sentiu

function dir(): string {
  return process.env.HISTORICO_DIR ?? "data/historico";
}

export function diaVazio(dia: string, abertos: Record<string, string> = {}): DiaHistorico {
  return { dia, checagens: { total: 0, ok: 0, alerta: 0, erro: 0 }, primeiraEm: null, ultimaEm: null, eventos: [], abertos };
}

export function diaDe(agora: Date): string {
  return yyyymmddEmTz(agora);
}

export function lerDia(dia: string): DiaHistorico | null {
  if (!/^\d{8}$/.test(dia)) return null;
  const arq = join(dir(), `${dia}.json`);
  if (!existsSync(arq)) return null;
  try {
    return JSON.parse(readFileSync(arq, "utf8")) as DiaHistorico;
  } catch (erro) {
    // Arquivo ilegível não pode parar a checagem: guarda ao lado para análise e começa o dia de novo.
    const guardado = `${arq}.corrompido-${Date.now()}`;
    try {
      renameSync(arq, guardado);
    } catch {
      /* se nem renomear der, o próximo salvarDia sobrescreve */
    }
    console.error(`▶ Histórico ${dia} ilegível (${erro instanceof Error ? erro.message : String(erro)}); movido para ${guardado}`);
    return null;
  }
}

export function salvarDia(d: DiaHistorico): void {
  mkdirSync(dir(), { recursive: true });
  const arq = join(dir(), `${d.dia}.json`);
  // tmp + rename: crash no meio da escrita não corrompe o dia
  writeFileSync(`${arq}.tmp`, JSON.stringify(d, null, 1));
  renameSync(`${arq}.tmp`, arq);
}

export function listarDias(): string[] {
  if (!existsSync(dir())) return [];
  return readdirSync(dir())
    .filter((f) => /^\d{8}\.json$/.test(f))
    .map((f) => f.slice(0, 8))
    .sort()
    .reverse();
}

/** Dia mais recente gravado — usado na subida para não reabrir furos já conhecidos. */
export function ultimoDiaGravado(): DiaHistorico | null {
  const [dia] = listarDias();
  return dia ? lerDia(dia) : null;
}

// idade dos furos medida na última checagem do dia (dias passados não "envelhecem")
export function resumirDia(d: DiaHistorico, agora = new Date(d.ultimaEm ?? Date.now())): ResumoDia {
  const resolvidos = d.eventos.filter((e) => e.tipo === "furo_resolvido");
  const duracoes = resolvidos.map((e) => e.duracaoMin ?? 0);
  const idades = Object.values(d.abertos).map((iso) => Math.floor((agora.getTime() - new Date(iso).getTime()) / 60000));
  const maisAntigo = idades.length ? Math.max(...idades) : null;
  const furosAbertos = d.eventos.filter((e) => e.tipo === "furo_aberto").length;
  const falhas = d.eventos.filter((e) => e.tipo === "checagem_falhou").length;
  const { total, ok } = d.checagens;
  const nivel: ResumoDia["nivel"] =
    total === 0 ? "sem_dados"
    : maisAntigo != null && maisAntigo >= CRITICO_MIN ? "critico"
    : furosAbertos || idades.length || falhas || ok < total ? "atencao"
    : "saudavel";
  return {
    nivel,
    saudePct: total ? Math.round((ok / total) * 1000) / 10 : null,
    furosAbertos,
    furosResolvidos: resolvidos.length,
    resolucaoMediaMin: duracoes.length ? Math.round(duracoes.reduce((a, b) => a + b, 0) / duracoes.length) : null,
    resolucaoMaxMin: duracoes.length ? Math.max(...duracoes) : null,
    abertosAgora: idades.length,
    maisAntigoMin: maisAntigo,
    falhasChecagem: falhas,
  };
}
