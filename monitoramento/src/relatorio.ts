// Textos dos avisos (Chat / e-mail / WhatsApp) enviados pelo n8n a partir de /ciclo e /ciclo/conferir.
import type { ItemRastro, Passo, ProximaAcao } from "./diagnostico.js";
import type { ResultadoSerie } from "./types.js";

export type Mensagem = { assunto: string; mensagem: string };
type Nota = { numero: number; serie: number };

/** Item do lote: o diagnóstico de uma NF ausente (ou o motivo de não ter diagnóstico). */
export type ItemLote = {
  referencia: string;
  numero: number;
  serie: number;
  invoiceId: string | null;
  chave?: string | null;
  proximaAcao: ProximaAcao;
  diagnostico: string;
  passos?: Passo[];
  contigencia?: { notificationId: string; httpStatus: number } | null;
  rastro?: ItemRastro[];
  mensagem?: string;
};

export type RelatorioNota = Mensagem & {
  referencia: string;
  numero: number;
  serie: number;
  invoiceId: string | null;
  proximaAcao: ProximaAcao;
  diagnostico: string;
  precisaAdmin: boolean;
  resolvido: boolean;
  xmlNoFtp: boolean | null;
};

export const mesmaNota = (a: Nota, b: Nota) => Number(a.numero) === Number(b.numero) && Number(a.serie) === Number(b.serie);

export function horarioSaoPaulo(d = new Date()): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** "série 2: 22395–22396, 22414" */
export function listarAusentes(notas: Nota[]): string {
  const porSerie = new Map<number, number[]>();
  for (const n of notas) {
    const s = Number(n.serie);
    if (!porSerie.has(s)) porSerie.set(s, []);
    porSerie.get(s)!.push(Number(n.numero));
  }
  const linhas: string[] = [];
  for (const [serie, nums] of [...porSerie.entries()].sort((a, b) => a[0] - b[0])) {
    nums.sort((a, b) => a - b);
    const partes: string[] = [];
    let i = 0;
    while (i < nums.length) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      partes.push(i === j ? String(nums[i]) : `${nums[i]}–${nums[j]}`);
      i = j + 1;
    }
    linhas.push(`série ${serie}: ${partes.join(", ")}`);
  }
  return linhas.join("\n");
}

export function mensagemResumo(opts: {
  identificador: string;
  series: ResultadoSerie[];
  tetoPeriodo?: { start: string; end: string } | null;
  notasAusentes: Nota[];
  integracaoOk: boolean;
  avisos: string[];
  fake: boolean;
  horario: string;
}): Mensagem {
  const { tetoPeriodo: p } = opts;
  const periodo = p ? (p.start === p.end ? `Período teto ML: ${p.start}` : `Período teto ML: ${p.start}–${p.end}`) : "";
  const seriesLinha = opts.series
    .map((s) => `série ${s.serie} (FTP ${s.min} → ${s.max}${s.tetoMl != null ? `, teto ML ${s.tetoMl} ` : ""})`)
    .join("\n");
  const cabecalho = [opts.identificador, periodo, seriesLinha].filter(Boolean).join("\n");
  const prefixo = opts.fake ? "[TESTE FAKE_NOTA] " : "";

  if (opts.integracaoOk && opts.avisos.length) {
    // Nunca "100% OK" aqui (falso verde): sem teto ML a sequência não é confiável.
    const titulo = `Monitoramento com cobertura parcial ${opts.horario}`;
    return {
      assunto: prefixo + titulo,
      mensagem:
        `${prefixo}${titulo}\n\n` +
        "⚠️ Não dá para garantir que todas as notas chegaram ao FTP:\n" +
        opts.avisos.map((a) => `• ${a}`).join("\n") +
        "\n\nNenhum furo visível no FTP, mas notas no fim da sequência podem estar faltando.\n\n" +
        cabecalho,
    };
  }
  if (opts.integracaoOk) {
    const titulo = `Monitoramento concluído ${opts.horario}`;
    return {
      assunto: prefixo + titulo,
      mensagem:
        `${prefixo}${titulo}\n\n` +
        "A integração de NF-e das séries monitoradas está 100% OK.\n" +
        "A última NF emitida pelo Mercado Livre está no FTP.\n\n" +
        cabecalho,
    };
  }
  const titulo = `Monitoramento com pendências ${opts.horario}`;
  const lista = opts.notasAusentes.length ? listarAusentes(opts.notasAusentes) : "";
  return {
    assunto: prefixo + titulo,
    mensagem:
      `${prefixo}${titulo}\n\n` +
      cabecalho +
      (lista ? `\n\nNotas ausentes no FTP (${opts.notasAusentes.length}):\n${lista}\n\nDiagnóstico automático em todas.` : ""),
  };
}

export function mensagemSerieSemXml(identificador: string, execucao: string): Mensagem {
  return {
    assunto: `NF-e ${identificador} — série sem XML para cruzar`,
    mensagem:
      (identificador ? `NF ${identificador}\n\n` : "") +
      "⚠️ Precisa de atenção — não foi possível cruzar esta série com o Mercado Livre.\n" +
      "Não há XML no FTP para montar a sequência das notas.\n\n" +
      "O que fazer:\n" +
      "Acionar o time técnico.\n\n" +
      `execução=${execucao}`,
  };
}

export function itemInvoiceAusente(nota: Nota, execucao: string): ItemLote {
  const referencia = `${nota.numero}/${nota.serie}`;
  return {
    referencia,
    numero: nota.numero,
    serie: nota.serie,
    invoiceId: null,
    proximaAcao: "nenhuma",
    diagnostico: "A nota não foi encontrada no relatório do Mercado Livre.",
    mensagem:
      `NF ${referencia}\n\n` +
      "⚠️ Precisa de atenção — a nota não foi encontrada no relatório do Mercado Livre.\n\n" +
      "Sem o identificador da nota no Mercado Livre, o diagnóstico no Nerus não consegue rodar.\n\n" +
      "O que fazer:\n" +
      "Acionar o time técnico.\n\n" +
      `execução=${execucao}`,
  };
}

/** Espera única do lote: entrega pendente (10 min) vence contingência (2 min). */
export function decidirEsperaLote(acoes: ProximaAcao[]): "10min" | "2min" | "nenhuma" {
  if (acoes.includes("esperar_entrega")) return "10min";
  if (acoes.includes("contigencia")) return "2min";
  return "nenhuma";
}

export function dumpRastro(itens: ItemRastro[] = []): string {
  return itens
    .map((item) => {
      const ls = [`${item.n}. ${item.tabela}`];
      if (item.filtro) ls.push(`   WHERE ${item.filtro}`);
      if (!item.executado) ls.push(`   → não executado — ${item.detalhe}`);
      else if (String(item.detalhe || "").startsWith("ERRO:")) ls.push(`   → ${item.detalhe}`);
      else if (!item.linhas && (!item.detalhe || item.detalhe === "0 linhas")) ls.push("   → 0 linhas");
      else ls.push(`   → ${item.linhas} linha(s)${item.detalhe ? " — " + item.detalhe : ""}`);
      return ls.join("\n");
    })
    .join("\n\n");
}

/** Relatório final de uma NF do lote, depois da conferência no FTP. */
export function relatorioNota(diag: ItemLote, ausentesAgora: Nota[] | null, execucao: string): RelatorioNota {
  const xmlNoFtp = ausentesAgora ? !ausentesAgora.some((n) => mesmaNota(n, diag)) : null;
  const referencia = diag.referencia || `${diag.numero}/${diag.serie}`;
  const invoiceId = diag.invoiceId || "";
  const chave = diag.chave || "";
  const diagnostico = diag.diagnostico || diag.mensagem || "Não foi possível montar o diagnóstico.";
  const proximaAcao = diag.proximaAcao || "nenhuma";
  const passos = Array.isArray(diag.passos) ? diag.passos : [];
  const c = passos.find((p) => p.id === "contigencia");

  let oQueMonitorFez = "Não reenviou o aviso: o problema não é falta de notificação do Mercado Livre.";
  if (c && c.status === "ok") {
    if (xmlNoFtp === true) oQueMonitorFez = "Reenviou o aviso ao sistema (contingência). Depois disso, o XML apareceu no FTP.";
    else if (xmlNoFtp === false) oQueMonitorFez = "Reenviou o aviso ao sistema (contingência) e conferiu de novo. A nota ainda não chegou ao FTP.";
    else oQueMonitorFez = "Reenviou o aviso ao sistema (contingência).";
  } else if (c && c.status === "info") {
    oQueMonitorFez = c.detalhe; // trava: aviso já reenviado na janela de 30 min
  } else if (c && c.status === "erro") {
    oQueMonitorFez = `Tentou reenviar o aviso ao sistema (contingência), mas não conseguiu: ${c.detalhe}`;
  } else if (proximaAcao === "esperar_entrega") {
    oQueMonitorFez = xmlNoFtp === true
      ? "Aguardou o envio ao FTP. O XML apareceu na pasta."
      : "Aguardou o envio ao FTP, mas o arquivo ainda não apareceu na pasta.";
  } else if (proximaAcao === "rechecar_ftp") {
    oQueMonitorFez = xmlNoFtp === true
      ? "Conferiu o FTP e encontrou o XML."
      : "O envio ao FTP já tinha sido disparado, mas o arquivo ainda não estava na pasta.";
  }

  const [banner, oQueFazer, sufixo] =
    xmlNoFtp === true
      ? ["✅ Resolvido — o XML da nota já está no FTP.", "Nada a fazer.", "resolvido"]
      : xmlNoFtp === false
        ? ["⚠️ Ainda não resolvido — a nota continua ausente no FTP.", "O monitor ainda vai conferir o lote de novo. Se persistir, acionar o time técnico.", "ainda ausente no FTP"]
        : ["⚠️ Precisa de atenção — a nota não chegou ao FTP.", "Acionar o time técnico.", "precisa de atenção"];

  const linhas = [
    `NF ${referencia}`,
    "",
    banner,
    oQueFazer,
    "",
    xmlNoFtp === true ? "O que tinha acontecido:" : "O que aconteceu:",
    diagnostico,
    "",
    "O que o monitor fez:",
    oQueMonitorFez,
  ];
  if (xmlNoFtp !== true) {
    const pipeline = passos.filter((p) => p.id !== "contigencia");
    const primeiroErro = pipeline.findIndex((p) => p.status === "erro");
    const visiveis = primeiroErro >= 0 ? pipeline.slice(0, primeiroErro + 1) : pipeline;
    if (visiveis.length) {
      linhas.push("", "Onde a integração parou:");
      for (const p of visiveis) linhas.push(p.detalhe ? `• ${p.titulo} — ${p.detalhe}` : `• ${p.titulo}`);
      if (primeiroErro >= 0 && primeiroErro < pipeline.length - 1) linhas.push("Os passos seguintes ainda não rodaram por causa disso.");
    }
  }
  linhas.push("", "Rastro técnico");
  linhas.push(`invoice_id=${invoiceId}${chave ? "  chave=" + chave : ""}`);
  if (Array.isArray(diag.rastro) && diag.rastro.length) linhas.push("", dumpRastro(diag.rastro));
  else if (diag.contigencia?.notificationId) linhas.push(`contingência ${diag.contigencia.notificationId}`);
  if (xmlNoFtp === true) linhas.push("Rechecar SFTP → XML encontrado");
  else if (xmlNoFtp === false) linhas.push("Rechecar SFTP → XML ainda ausente");
  linhas.push(`execução=${execucao}`);

  return {
    referencia,
    numero: diag.numero,
    serie: diag.serie,
    invoiceId: invoiceId || null,
    proximaAcao,
    diagnostico,
    precisaAdmin: xmlNoFtp !== true,
    resolvido: xmlNoFtp === true,
    xmlNoFtp,
    assunto: `NF-e ${referencia} — ${sufixo}`,
    mensagem: linhas.join("\n"),
  };
}

/** Resumo do lote: quantas das NFs ausentes já chegaram ao FTP. */
export function relatorioConferencia(originais: Nota[], ausentesAgora: Nota[], execucao: string): Mensagem & {
  faltando: Nota[];
  noFtp: number;
  total: number;
} {
  const faltando = originais.filter((o) => ausentesAgora.some((a) => mesmaNota(a, o)));
  const noFtp = originais.length - faltando.length;
  const listaFalta = faltando.map((n) => `${n.numero}/${n.serie}`).join(", ");
  const listaOk = originais
    .filter((o) => !faltando.some((f) => f.numero === o.numero && f.serie === o.serie))
    .map((n) => `${n.numero}/${n.serie}`)
    .join(", ");
  const base = { faltando, noFtp, total: originais.length };
  if (originais.length === 0) {
    return { ...base, assunto: "Lote de furos — nada a conferir", mensagem: "Não havia furos para conferir no FTP." };
  }
  const assunto = `Lote de furos — ${noFtp}/${originais.length} no FTP`;
  if (faltando.length === 0) {
    return {
      ...base,
      assunto,
      mensagem:
        `✅ Lote concluído — as ${originais.length} notas ausentes já estão no FTP.\n\n` +
        `Notas: ${listaOk}\n\n` +
        `execução=${execucao}`,
    };
  }
  return {
    ...base,
    assunto,
    mensagem:
      `⚠️ Lote incompleto — ${noFtp} de ${originais.length} notas estão no FTP.\n\n` +
      (listaOk ? `Já no FTP: ${listaOk}\n` : "") +
      `Ainda faltam: ${listaFalta}\n\n` +
      "Acionar o time técnico para as que continuam ausentes.\n\n" +
      `execução=${execucao}`,
  };
}
