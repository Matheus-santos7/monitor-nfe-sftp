// Ciclo completo: checagem/diagnóstico → espera do lote → conferência (→ 2 min → de novo) → avisos.
// Quem dispara: a agenda (index.ts) e o botão "Executar agora" do painel.
import { conferirLote, depsReais, rodarCiclo, type ResultadoCiclo, type ResultadoConferencia } from "./ciclo.js";
import { canaisDoAmbiente, enviarAviso, type ResultadoEnvio } from "./avisos.js";
import { registrarEventoAviso } from "./job.js";
import type { Mensagem } from "./relatorio.js";
import type { AppConfig } from "./types.js";

/** off = pausado · sombra = roda sem contingência e sem enviar avisos · ativo = produção. */
export type ModoAgenda = "off" | "sombra" | "ativo";

export function modoAgenda(env: Record<string, string | undefined> = process.env): ModoAgenda {
  const v = env.MODO_AGENDA?.trim().toLowerCase();
  return v === "ativo" || v === "sombra" ? v : "off";
}

export type DepsOrquestrador = {
  ciclo: (execucao: string, opcoes: { contingencia: boolean }) => Promise<ResultadoCiclo>;
  conferir: (entrada: { notas: ResultadoCiclo["notasAusentes"]; lote: ResultadoCiclo["lote"]; execucao: string }) => Promise<ResultadoConferencia>;
  enviar: (m: Mensagem) => Promise<ResultadoEnvio>;
  esperar: (ms: number) => Promise<void>;
  registrar: (texto: string) => void;
  agora: () => Date;
};

export type ResumoRodada = {
  execucao: string;
  origem: "agenda" | "manual";
  /** Quem disparou (conta do painel ou token-api), só em origem manual. */
  quem?: string;
  sombra: boolean;
  inicio: string;
  fim: string;
  status: ResultadoCiclo["status"] | "falhou";
  etapaFalha: string | null;
  erro: string | null;
  mensagens: number;
  /** Mensagens que nenhum canal entregou. > 0 = ninguém foi avisado daquele aviso. */
  semEntrega: number;
};

export type EstadoCiclo = {
  modo: ModoAgenda;
  agenda: string | null;
  proximo: string | null;
  emAndamento: boolean;
  execucao: string | null;
  etapa: string | null;
  aguardandoAte: string | null;
  ultimo: ResumoRodada | null;
};

const ESPERA_MS: Record<ResultadoCiclo["espera"], number> = { "10min": 600_000, "2min": 120_000, nenhuma: 0 };
const RECONFERIR_MS = 120_000;

const estado: Omit<EstadoCiclo, "modo" | "agenda" | "proximo"> = {
  emAndamento: false,
  execucao: null,
  etapa: null,
  aguardandoAte: null,
  ultimo: null,
};
let agenda: { modo: ModoAgenda; expressao: string | null; proximo: () => Date | null } = {
  modo: "off",
  expressao: null,
  proximo: () => null,
};

/** index.ts informa a agenda ativa, para o painel mostrar o modo e o próximo horário. */
export function configurarAgenda(a: typeof agenda): void {
  agenda = a;
}

export function estadoCiclo(): EstadoCiclo {
  return { ...estado, modo: agenda.modo, agenda: agenda.expressao, proximo: agenda.proximo()?.toISOString() ?? null };
}

export function depsOrquestradorReais(config: AppConfig): DepsOrquestrador {
  const deps = depsReais(config);
  const canais = canaisDoAmbiente(); // o .env só muda recriando o container
  return {
    ciclo: (execucao, o) => rodarCiclo(deps, execucao, new Date(), o),
    conferir: (entrada) => conferirLote(deps, entrada),
    enviar: (m) => enviarAviso(m, canais),
    esperar: (ms) => new Promise((ok) => setTimeout(ok, ms)),
    registrar: (texto) => registrarEventoAviso(texto),
    agora: () => new Date(),
  };
}

function mensagemFalha(execucao: string, etapa: string, erro: string): Mensagem {
  return {
    assunto: "Falha no ciclo de monitoramento NF-e",
    mensagem: `🚨 O ciclo de monitoramento falhou.\n\netapa=${etapa}\nexecução=${execucao}\nerro=${erro}`,
  };
}

export async function executarCicloCompleto(
  deps: DepsOrquestrador,
  opcoes: { execucao: string; origem: ResumoRodada["origem"]; sombra: boolean; quem?: string },
): Promise<ResumoRodada> {
  const { execucao, origem, sombra, quem } = opcoes;
  const inicio = deps.agora().toISOString();
  let status: ResumoRodada["status"] = "falhou";
  let etapaFalha: string | null = null;
  let erro: string | null = null;
  let mensagens: Mensagem[] = [];
  const etapa = (nome: string) => {
    estado.etapa = nome;
    return nome;
  };
  const esperar = async (ms: number) => {
    if (!ms) return;
    estado.aguardandoAte = new Date(deps.agora().getTime() + ms).toISOString();
    await deps.esperar(ms);
    estado.aguardandoAte = null;
  };

  let atual = "ciclo";
  try {
    atual = etapa("ciclo");
    const r = await deps.ciclo(execucao, { contingencia: !sombra });
    status = r.status;
    mensagens = r.mensagens;
    if (r.lote.length) {
      atual = etapa(`espera do lote (${r.espera})`);
      await esperar(ESPERA_MS[r.espera]);
      atual = etapa("conferência");
      const entrada = { notas: r.notasAusentes, lote: r.lote, execucao };
      let c = await deps.conferir(entrada);
      if (c.aindaFaltam) {
        atual = etapa("espera da reconferência (2min)");
        await esperar(RECONFERIR_MS);
        atual = etapa("reconferência");
        c = await deps.conferir(entrada);
      }
      mensagens = c.mensagens;
    }
  } catch (e) {
    status = "falhou";
    etapaFalha = atual;
    erro = e instanceof Error ? e.message : String(e);
    console.error(`▶ Ciclo ${execucao} falhou em ${atual}: ${erro}`);
    mensagens = [mensagemFalha(execucao, atual, erro)];
  }

  etapa("envio dos avisos");
  let semEntrega = 0;
  for (const m of mensagens) {
    if (sombra) {
      console.log(`▶ [sombra] aviso não enviado: ${m.assunto}`);
      continue;
    }
    const envio = await deps.enviar(m);
    if (!envio.entregues.length) {
      semEntrega++;
      const motivo = envio.falhas.length ? envio.falhas.map((f) => `${f.canal}: ${f.erro}`).join("; ") : "nenhum canal configurado";
      deps.registrar(`Aviso "${m.assunto}" não foi entregue em nenhum canal (${motivo})`);
    }
  }

  const resumo: ResumoRodada = {
    execucao,
    origem,
    ...(quem ? { quem } : {}),
    sombra,
    inicio,
    fim: deps.agora().toISOString(),
    status,
    etapaFalha,
    erro,
    mensagens: mensagens.length,
    semEntrega,
  };
  console.log(`▶ Ciclo ${execucao}${sombra ? " [sombra]" : ""}: ${status}, ${mensagens.length} aviso(s)${semEntrega ? `, ${semEntrega} sem entrega` : ""}`);
  return resumo;
}

/** Dispara em segundo plano. Uma rodada por vez: com outra em andamento (ex.: na espera do lote), retorna false. */
export function dispararCiclo(
  deps: DepsOrquestrador,
  opcoes: { origem: ResumoRodada["origem"]; sombra: boolean; quem?: string },
): boolean {
  if (estado.emAndamento) {
    console.log(`▶ Ciclo (${opcoes.origem}) pulado: o anterior ainda está em ${estado.etapa ?? "andamento"}`);
    return false;
  }
  const execucao = `${opcoes.origem}-${deps.agora().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}`;
  Object.assign(estado, { emAndamento: true, execucao, etapa: null, aguardandoAte: null });
  executarCicloCompleto(deps, { ...opcoes, execucao })
    .then((r) => {
      estado.ultimo = r;
    })
    .catch((e) => console.error(`▶ Erro inesperado no ciclo ${execucao}: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => Object.assign(estado, { emAndamento: false, execucao: null, etapa: null, aguardandoAte: null }));
  return true;
}
