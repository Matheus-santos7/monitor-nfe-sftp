import { queryNerus, type Linha } from "./nerus-db.js";
import { renotificarInvoice } from "./nerus-contigencia.js";

export type Passo = {
  id: string;
  titulo: string;
  status: "ok" | "alerta" | "erro" | "info";
  detalhe: string;
};

export type ProximaAcao = "nenhuma" | "esperar_entrega" | "contigencia" | "rechecar_ftp";

export type RelatorioDiagnostico = {
  referencia: string;
  invoiceId: string;
  chave: string | null;
  numero: number;
  serie: number;
  notificacaoRecebida: boolean;
  entregaEnviada: boolean;
  precisaAdmin: boolean;
  proximaAcao: ProximaAcao;
  diagnostico: string;
  passos: Passo[];
  assunto: string;
  mensagem: string;
  notificacao?: Linha | null;
  alvos?: Linha[];
  invoice?: Linha | null;
  entregas?: Linha[];
  contigencia?: { notificationId: string; httpStatus: number } | null;
  rastro?: ItemRastro[];
};

export type ItemRastro = {
  n: number;
  tabela: string;
  executado: boolean;
  filtro: string;
  linhas: number;
  detalhe: string;
};

const SENT = new Set(["SENT"]);
const EM_ANDAMENTO = new Set(["PENDING", "PROCESSING", "RETRY_SCHEDULED"]);
const TERMINAL_RUIM = new Set(["FAILED", "SKIPPED", "CANCELED"]);

function soCampos(row: Linha | null, campos: string[]): Linha | null {
  if (!row) return null;
  const out: Linha = {};
  for (const c of campos) {
    if (c in row) out[c] = row[c];
  }
  return out;
}

function formatarBrasilia(d: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(d)
    .replace(",", "");
}

/** Mostra o valor da tabela e a conversão para Brasília (RDS costuma gravar UTC). */
export function horarioTabelaEBrasilia(raw: unknown): string {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const tabela = raw.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
    return `${tabela} → ${formatarBrasilia(raw)} (Brasília)`;
  }
  const tabela = String(raw ?? "").trim();
  if (!tabela) return "sem horário";
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(tabela)
    ? tabela
    : tabela.includes("T")
      ? tabela
      : `${tabela.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return tabela;
  return `${tabela} → ${formatarBrasilia(d)} (Brasília)`;
}

function instanteOrdenacao(raw: unknown): number {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.getTime();
  const s = String(raw ?? "").trim();
  if (!s) return 0;
  const d = new Date(s.includes("T") || /[zZ]$/.test(s) ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

export function classificarEntregas(
  entregas: { status?: unknown }[],
): "enviada" | "pendente" | "falhou" | "ausente" {
  if (!entregas.length) return "ausente";
  const statuses = entregas.map((e) => String(e.status ?? "").trim().toUpperCase());
  if (statuses.some((s) => SENT.has(s))) return "enviada";
  if (statuses.some((s) => EM_ANDAMENTO.has(s))) return "pendente";
  if (statuses.some((s) => TERMINAL_RUIM.has(s))) return "falhou";
  return "pendente";
}

export function decidirAcao(input: {
  notificacao: Linha | null;
  alvos: { status?: unknown }[];
  invoice: Linha | null;
  entregas: { status?: unknown }[];
}): { diagnostico: string; precisaAdmin: boolean; proximaAcao: ProximaAcao } {
  if (!input.notificacao) {
    return {
      diagnostico:
        "O Mercado Livre emitiu a nota, mas não avisou o sistema. Sem esse aviso, a nota não entra no Nerus e o XML não vai para o FTP.",
      precisaAdmin: true,
      proximaAcao: "contigencia",
    };
  }

  const algumSucesso = input.alvos.some((a) => String(a.status ?? "").toUpperCase() === "SUCCESS");
  const algumErro = input.alvos.some((a) => String(a.status ?? "").toUpperCase() === "ERROR");

  if (!input.invoice) {
    return {
      diagnostico: algumSucesso
        ? "O Mercado Livre avisou o sistema, mas a nota não foi registrada no Nerus. Sem o registro, o XML não vai para o FTP."
        : "O Mercado Livre avisou o sistema, mas o aviso não foi processado. A nota não foi registrada no Nerus.",
      precisaAdmin: true,
      proximaAcao: "nenhuma",
    };
  }

  const statusesEntrega = input.entregas
    .map((e) => String(e.status ?? "").trim().toUpperCase())
    .filter(Boolean)
    .join(", ");
  const entrega = classificarEntregas(input.entregas);
  if (entrega === "enviada") {
    return {
      diagnostico:
        "A nota já estava no Nerus e o envio ao FTP já tinha sido disparado. Faltava só confirmar se o XML chegou na pasta.",
      precisaAdmin: false,
      proximaAcao: "rechecar_ftp",
    };
  }
  if (entrega === "pendente") {
    return {
      diagnostico: `A nota já estava no Nerus, mas o envio ao FTP ainda não tinha concluído (${statusesEntrega || "em andamento"}).`,
      precisaAdmin: true,
      proximaAcao: "esperar_entrega",
    };
  }
  if (entrega === "falhou") {
    return {
      diagnostico: `A nota está no Nerus, mas o envio ao FTP falhou (${statusesEntrega}).`,
      precisaAdmin: true,
      proximaAcao: "nenhuma",
    };
  }
  return {
    diagnostico: algumErro
      ? "A nota está no Nerus, mas não há registro de envio ao FTP. O aviso do Mercado Livre teve falha no processamento."
      : "A nota está no Nerus, mas não há registro de envio ao FTP.",
    precisaAdmin: true,
    proximaAcao: "nenhuma",
  };
}

function horarioBrasilia(raw: unknown): string {
  const full = horarioTabelaEBrasilia(raw);
  const seta = full.indexOf(" → ");
  return seta >= 0 ? full.slice(seta + 3) : full;
}

function rotuloEntrega(status: string): string {
  const s = status.trim().toUpperCase();
  if (s === "SENT") return "enviado";
  if (s === "PENDING") return "aguardando envio";
  if (s === "PROCESSING") return "enviando";
  if (s === "RETRY_SCHEDULED") return "nova tentativa agendada";
  if (s === "FAILED") return "falhou";
  if (s === "SKIPPED") return "ignorado";
  if (s === "CANCELED") return "cancelado";
  return s || "desconhecido";
}

function rotuloInvoice(status: unknown): string {
  const s = String(status ?? "").trim().toUpperCase();
  if (s === "AUTHORIZED") return "autorizada";
  if (s === "CANCELED" || s === "CANCELLED") return "cancelada";
  if (s === "DENIED") return "denegada";
  return s || "sem status";
}

export type ExtraConclusao = {
  xmlNoFtp?: boolean | null;
  classificacaoEntregaAposEspera?: ReturnType<typeof classificarEntregas> | null;
  entregaDetalhe?: string | null;
  executionId?: string | number | null;
};

function celula(v: unknown): string {
  if (v == null || v === "") return "null";
  if (v instanceof Date && !Number.isNaN(v.getTime())) return horarioTabelaEBrasilia(v);
  return String(v);
}

function msgConsulta(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

export function erroDeConsulta(rastro: ItemRastro[]): ItemRastro | undefined {
  return rastro.find((i) => i.executado && i.detalhe.startsWith("ERRO:"));
}

function rastroDoEstado(r: Omit<RelatorioDiagnostico, "assunto" | "mensagem">): ItemRastro[] {
  if (r.rastro && r.rastro.length) return r.rastro;
  const itens: ItemRastro[] = [];
  let n = 0;
  const notif = r.notificacao ?? null;
  itens.push({
    n: ++n,
    tabela: "nerus_gateway.notification_control",
    executado: true,
    filtro: `type_notification='invoices' AND notification_sended LIKE '%/invoices/${r.invoiceId}%'`,
    linhas: notif ? 1 : 0,
    detalhe: notif
      ? `id=${celula(notif.id)} date_notification=${horarioTabelaEBrasilia(notif.date_notification)}`
      : "0 linhas",
  });
  const alvos = r.alvos ?? [];
  if (!notif?.id) {
    itens.push({
      n: ++n,
      tabela: "nerus_gateway.notification_control_target",
      executado: false,
      filtro: "notification_control_id=?",
      linhas: 0,
      detalhe: "sem notification_control.id",
    });
  } else {
    itens.push({
      n: ++n,
      tabela: "nerus_gateway.notification_control_target",
      executado: true,
      filtro: `notification_control_id=${celula(notif.id)}`,
      linhas: alvos.length,
      detalhe: alvos.length
        ? alvos
            .map(
              (a) =>
                `id=${celula(a.id)} status=${String(a.status ?? "").toUpperCase() || "null"} retry_count=${celula(a.retry_count)} last_retry=${horarioTabelaEBrasilia(a.last_retry)}`,
            )
            .join("; ")
        : "0 linhas",
    });
  }
  const inv = r.invoice ?? null;
  itens.push({
    n: ++n,
    tabela: "nerus_o2.invoice",
    executado: true,
    filtro: `external_id=${r.invoiceId}`,
    linhas: inv ? 1 : 0,
    detalhe: inv
      ? `id=${celula(inv.id)} status=${celula(inv.status)} channel_status=${celula(inv.channel_status)} key_nfe=${celula(inv.key_nfe)}`
      : "0 linhas",
  });
  const entregas = r.entregas ?? [];
  if (!r.chave) {
    itens.push({
      n: ++n,
      tabela: "nerus_o2.fiscal_document_deliveries",
      executado: false,
      filtro: "tenant_id=? AND document_id=?",
      linhas: 0,
      detalhe: "sem chave NF-e",
    });
  } else {
    itens.push({
      n: ++n,
      tabela: "nerus_o2.fiscal_document_deliveries",
      executado: true,
      filtro: `document_id=${r.chave}`,
      linhas: entregas.length,
      detalhe: entregas.length
        ? entregas
            .map(
              (e) =>
                `id=${celula(e.id)} status=${String(e.status ?? "").toUpperCase() || "null"} created_at=${horarioTabelaEBrasilia(e.created_at)} updated_at=${horarioTabelaEBrasilia(e.updated_at)}`,
            )
            .join("; ")
        : "0 linhas",
    });
  }
  if (r.contigencia) {
    itens.push({
      n: ++n,
      tabela: "POST contingência (topic=invoices)",
      executado: true,
      filtro: `resource=/users/…/invoices/${r.invoiceId}`,
      linhas: 1,
      detalhe: `HTTP ${r.contigencia.httpStatus} notification_id=${r.contigencia.notificationId}`,
    });
  } else if (r.passos.some((p) => p.id === "contigencia" && p.status === "erro")) {
    const c = r.passos.find((p) => p.id === "contigencia");
    itens.push({
      n: ++n,
      tabela: "POST contingência (topic=invoices)",
      executado: true,
      filtro: `resource=/users/…/invoices/${r.invoiceId}`,
      linhas: 0,
      detalhe: `ERRO: ${c?.detalhe || "falhou"}`,
    });
  } else if (r.proximaAcao === "contigencia") {
    itens.push({
      n: ++n,
      tabela: "POST contingência (topic=invoices)",
      executado: false,
      filtro: `resource=/users/…/invoices/${r.invoiceId}`,
      linhas: 0,
      detalhe: "ainda não disparada neste relatório",
    });
  } else {
    itens.push({
      n: ++n,
      tabela: "POST contingência (topic=invoices)",
      executado: false,
      filtro: `resource=/users/…/invoices/${r.invoiceId}`,
      linhas: 0,
      detalhe: "não disparada (não era falta de aviso do ML)",
    });
  }
  return itens;
}

export function formatarRastro(
  r: Omit<RelatorioDiagnostico, "assunto" | "mensagem">,
  extra: ExtraConclusao = {},
): string {
  const itens = rastroDoEstado(r);
  const linhas: string[] = ["Rastro técnico"];
  linhas.push(`invoice_id=${r.invoiceId}${r.chave ? `  chave=${r.chave}` : ""}`);
  for (const item of itens) {
    linhas.push("");
    linhas.push(`${item.n}. ${item.tabela}`);
    if (item.filtro) linhas.push(`   WHERE ${item.filtro}`);
    if (!item.executado) {
      linhas.push(`   → não executado — ${item.detalhe}`);
      continue;
    }
    if (item.detalhe.startsWith("ERRO:")) {
      linhas.push(`   → ${item.detalhe}`);
      continue;
    }
    if (item.linhas === 0 && (!item.detalhe || item.detalhe === "0 linhas")) {
      linhas.push("   → 0 linhas");
      continue;
    }
    linhas.push(`   → ${item.linhas} linha(s)${item.detalhe ? ` — ${item.detalhe}` : ""}`);
  }
  const n0 = itens.length;
  if (extra.classificacaoEntregaAposEspera != null || extra.xmlNoFtp != null) {
    linhas.push("");
    linhas.push(`${n0 + 1}. Reconsulta após espera (n8n)`);
    if (extra.classificacaoEntregaAposEspera != null) {
      const extraDet = extra.entregaDetalhe ? ` — ${extra.entregaDetalhe}` : "";
      linhas.push(`   POST /diagnostico/entrega → ${extra.classificacaoEntregaAposEspera}${extraDet}`);
    }
    if (extra.xmlNoFtp === true) linhas.push("   Rechecar SFTP → XML encontrado");
    if (extra.xmlNoFtp === false) linhas.push("   Rechecar SFTP → XML ainda ausente");
  }
  if (extra.executionId != null && String(extra.executionId).trim()) {
    linhas.push("");
    linhas.push(`execução n8n=${extra.executionId}`);
  }
  return linhas.join("\n");
}

function oQueMonitorFez(
  r: Omit<RelatorioDiagnostico, "assunto" | "mensagem">,
  xmlNoFtp: boolean | null,
): string {
  const contigencia = r.passos.find((p) => p.id === "contigencia");
  if (contigencia?.status === "ok") {
    if (xmlNoFtp === true) {
      return "Reenviou o aviso ao sistema (contingência). Depois disso, o XML apareceu no FTP.";
    }
    if (xmlNoFtp === false) {
      return "Reenviou o aviso ao sistema (contingência) e conferiu de novo. A nota ainda não chegou ao FTP.";
    }
    return "Reenviou o aviso ao sistema (contingência).";
  }
  if (contigencia?.status === "erro") {
    return `Tentou reenviar o aviso ao sistema (contingência), mas não conseguiu: ${contigencia.detalhe}`;
  }
  if (r.proximaAcao === "esperar_entrega") {
    if (xmlNoFtp === true) return "Aguardou o envio ao FTP. O XML apareceu na pasta.";
    if (xmlNoFtp === false) return "Aguardou o envio ao FTP, mas o arquivo ainda não apareceu na pasta.";
    return "A nota já estava no Nerus; o envio ao FTP ainda estava em andamento.";
  }
  if (r.proximaAcao === "rechecar_ftp") {
    if (xmlNoFtp === true) return "Conferiu o FTP e encontrou o XML.";
    if (xmlNoFtp === false) {
      return "O envio ao FTP já tinha sido disparado, mas o arquivo ainda não estava na pasta.";
    }
    return "O envio ao FTP já tinha sido disparado. Falta conferir se o XML chegou na pasta.";
  }
  return "Não reenviou o aviso: o problema não é falta de notificação do Mercado Livre.";
}

/** Mesmo desfecho do banner, em forma de rótulo — é o que vai para o histórico. */
export type ResultadoFinal = "resolvido" | "em_andamento" | "precisa_atencao";

function resultadoHumano(opts: {
  xmlNoFtp: boolean | null;
  proximaAcao: ProximaAcao;
  entregaAposEspera: ExtraConclusao["classificacaoEntregaAposEspera"];
}): {
  banner: string;
  oQueFazer: string;
  assuntoSufixo: string;
  resolvido: boolean;
  precisaAdmin: boolean;
  categoria: ResultadoFinal;
} {
  if (opts.xmlNoFtp === true) {
    return {
      banner: "✅ Resolvido — o XML da nota já está no FTP.",
      oQueFazer: "Nada a fazer.",
      assuntoSufixo: "resolvido",
      resolvido: true,
      precisaAdmin: false,
      categoria: "resolvido",
    };
  }
  if (opts.xmlNoFtp === false && opts.entregaAposEspera === "enviada") {
    return {
      banner: "⏳ Em andamento — o envio ao FTP já foi disparado, mas o arquivo ainda não apareceu na pasta.",
      oQueFazer: "Aguardar o próximo ciclo de monitoramento. Se a nota não aparecer, acionar o time técnico.",
      assuntoSufixo: "envio em andamento",
      resolvido: false,
      precisaAdmin: true,
      categoria: "em_andamento",
    };
  }
  if (opts.xmlNoFtp === false) {
    return {
      banner: "⚠️ Ainda não resolvido — a nota continua ausente no FTP.",
      oQueFazer: "Acionar o time técnico.",
      assuntoSufixo: "ainda ausente no FTP",
      resolvido: false,
      precisaAdmin: true,
      categoria: "precisa_atencao",
    };
  }
  if (opts.proximaAcao === "contigencia") {
    return {
      banner: "⚠️ Pendência — o Mercado Livre não avisou o sistema.",
      oQueFazer: "O monitor já reenviou o aviso. Aguardar 1–3 minutos e conferir se o XML chegou ao FTP.",
      assuntoSufixo: "Mercado Livre não avisou",
      resolvido: false,
      precisaAdmin: true,
      categoria: "precisa_atencao",
    };
  }
  if (opts.proximaAcao === "esperar_entrega") {
    return {
      banner: "⏳ Em andamento — a nota está no Nerus, aguardando o envio ao FTP.",
      oQueFazer: "Aguardar cerca de 10 minutos e conferir de novo.",
      assuntoSufixo: "aguardando envio ao FTP",
      resolvido: false,
      precisaAdmin: true,
      categoria: "em_andamento",
    };
  }
  if (opts.proximaAcao === "rechecar_ftp") {
    return {
      banner: "⏳ Em andamento — conferindo se o XML já está no FTP.",
      oQueFazer: "Conferir o FTP. Se o XML não estiver lá, acionar o time técnico.",
      assuntoSufixo: "conferir FTP",
      resolvido: false,
      precisaAdmin: false,
      categoria: "em_andamento",
    };
  }
  return {
    banner: "⚠️ Precisa de atenção — a nota não chegou ao FTP.",
    oQueFazer: "Acionar o time técnico. Este caso não se resolve sozinho.",
    assuntoSufixo: "precisa de atenção",
    resolvido: false,
    precisaAdmin: true,
    categoria: "precisa_atencao",
  };
}

/** Texto para Chat/e-mail/WhatsApp. O n8n (Montar relatório do furo) remonta o mesmo formato depois de reconsultar o FTP. */
export function concluirRelatorio(
  r: Omit<RelatorioDiagnostico, "assunto" | "mensagem">,
  extra: ExtraConclusao = {},
): {
  assunto: string;
  mensagem: string;
  precisaAdmin: boolean;
  resolvido: boolean;
  resultadoFinal: ResultadoFinal;
} {
  const xmlNoFtp = extra.xmlNoFtp ?? null;
  const resultado = resultadoHumano({
    xmlNoFtp,
    proximaAcao: r.proximaAcao,
    entregaAposEspera: extra.classificacaoEntregaAposEspera ?? null,
  });

  const causaTitulo = xmlNoFtp === true ? "O que tinha acontecido:" : "O que aconteceu:";
  const linhas: string[] = [
    `NF ${r.referencia}`,
    "",
    resultado.banner,
    resultado.oQueFazer,
    "",
    causaTitulo,
    r.diagnostico,
    "",
    "O que o monitor fez:",
    oQueMonitorFez(r, xmlNoFtp),
  ];

  if (xmlNoFtp !== true) {
    const pipeline = r.passos.filter((p) => p.id !== "contigencia");
    const primeiroErro = pipeline.findIndex((p) => p.status === "erro");
    const visiveis = primeiroErro >= 0 ? pipeline.slice(0, primeiroErro + 1) : pipeline;
    if (visiveis.length) {
      linhas.push("", "Onde a integração parou:");
      for (const p of visiveis) {
        linhas.push(p.detalhe ? `• ${p.titulo} — ${p.detalhe}` : `• ${p.titulo}`);
      }
      if (primeiroErro >= 0 && primeiroErro < pipeline.length - 1) {
        linhas.push("Os passos seguintes ainda não rodaram por causa disso.");
      }
    }
  }

  linhas.push("", formatarRastro(r, extra));

  return {
    assunto: `NF-e ${r.referencia} — ${resultado.assuntoSufixo}`,
    mensagem: linhas.join("\n"),
    precisaAdmin: resultado.precisaAdmin,
    resolvido: resultado.resolvido,
    resultadoFinal: resultado.categoria,
  };
}

function alvosPorOrdemAsc(alvos: Linha[]): Linha[] {
  return [...alvos].sort((a, b) => instanteOrdenacao(a.last_retry) - instanteOrdenacao(b.last_retry));
}

function resumirAlvos(alvos: Linha[]): string {
  if (!alvos.length) return "";
  return alvosPorOrdemAsc(alvos)
    .map((a) => {
      const st = String(a.status ?? "").trim().toUpperCase();
      const rotulo = st === "SUCCESS" ? "ok" : st === "ERROR" ? "falhou" : st || "sem status";
      return `${rotulo} às ${horarioBrasilia(a.last_retry)}`;
    })
    .join("; ");
}

function resumirEntregas(entregas: Linha[]): string {
  if (!entregas.length) return "";
  return entregas
    .map((e) => {
      const rotulo = rotuloEntrega(String(e.status ?? ""));
      const quando = e.created_at ?? e.updated_at;
      return quando ? `${rotulo} às ${horarioBrasilia(quando)}` : rotulo;
    })
    .join("; ");
}

export function montarPassos(opts: {
  notificacao: Linha | null;
  alvos: Linha[];
  invoice: Linha | null;
  entregas: Linha[];
}): Passo[] {
  const notificou = Boolean(opts.notificacao);
  const passos: Passo[] = [
    {
      id: "ml",
      titulo: `Mercado Livre avisou o sistema? ${notificou ? "Sim" : "Não"}`,
      status: notificou ? "ok" : "erro",
      detalhe: notificou
        ? `Recebido às ${horarioBrasilia(opts.notificacao?.date_notification)}`
        : "O aviso não chegou ao Nerus.",
    },
  ];

  const alvos = alvosPorOrdemAsc(opts.alvos);
  const temErro = alvos.some((a) => String(a.status ?? "").toUpperCase() === "ERROR");
  const temOk = alvos.some((a) => String(a.status ?? "").toUpperCase() === "SUCCESS");
  let alvosTitulo: string;
  let alvosStatus: Passo["status"];
  let alvosDetalhe: string;
  if (!alvos.length) {
    alvosTitulo = `O sistema processou o aviso? ${notificou ? "Sem destino" : "Sem aviso"}`;
    alvosStatus = "alerta";
    alvosDetalhe = notificou
      ? "O aviso chegou, mas não havia destino configurado."
      : "Não havia aviso para processar.";
  } else if (temOk && !temErro) {
    alvosTitulo = "O sistema processou o aviso? Sim";
    alvosStatus = "ok";
    alvosDetalhe = resumirAlvos(alvos);
  } else if (temOk && temErro) {
    alvosTitulo = "O sistema processou o aviso? Atenção";
    alvosStatus = "alerta";
    alvosDetalhe = resumirAlvos(alvos);
  } else {
    alvosTitulo = "O sistema processou o aviso? Não";
    alvosStatus = "erro";
    alvosDetalhe = resumirAlvos(alvos);
  }
  passos.push({ id: "alvos", titulo: alvosTitulo, status: alvosStatus, detalhe: alvosDetalhe });

  if (opts.invoice) {
    passos.push({
      id: "invoice",
      titulo: "Nota registrada no Nerus? Sim",
      status: "ok",
      detalhe: rotuloInvoice(opts.invoice.status),
    });
  } else {
    passos.push({
      id: "invoice",
      titulo: "Nota registrada no Nerus? Não",
      status: "erro",
      detalhe: "A nota não foi encontrada no Nerus.",
    });
  }

  const entrega = classificarEntregas(opts.entregas);
  const resumoFtp = resumirEntregas(opts.entregas);
  if (entrega === "enviada") {
    passos.push({
      id: "ftp",
      titulo: "XML enviado ao FTP? Sim",
      status: "ok",
      detalhe: resumoFtp,
    });
  } else if (entrega === "pendente") {
    passos.push({
      id: "ftp",
      titulo: "XML enviado ao FTP? Ainda não",
      status: "alerta",
      detalhe: resumoFtp || "Envio em andamento.",
    });
  } else if (entrega === "falhou") {
    passos.push({
      id: "ftp",
      titulo: "XML enviado ao FTP? Não",
      status: "erro",
      detalhe: resumoFtp || "O envio falhou.",
    });
  } else {
    passos.push({
      id: "ftp",
      titulo: "XML enviado ao FTP? Não",
      status: "erro",
      detalhe: "Ainda sem registro de envio.",
    });
  }

  return passos;
}

export async function consultarEstadoNerus(opts: {
  invoiceId: string;
  chave?: string | null;
  mlUserId: string;
  tenantId: string;
}): Promise<{
  notificacao: Linha | null;
  alvos: Linha[];
  invoice: Linha | null;
  entregas: Linha[];
  rastro: ItemRastro[];
}> {
  const recurso = `/users/${opts.mlUserId}/invoices/${opts.invoiceId}`;
  const rastro: ItemRastro[] = [];
  let n = 0;

  let notificacao: Linha | null = null;
  try {
    const notificacoes = await queryNerus(
      `SELECT id, user_id, type_notification, date_notification
       FROM nerus_gateway.notification_control
       WHERE type_notification = 'invoices'
         AND user_id = ?
         AND notification_sended LIKE ?
       ORDER BY date_notification DESC
       LIMIT 5`,
      [opts.mlUserId, `%${recurso}%`],
    );
    notificacao = notificacoes[0] ?? null;
    rastro.push({
      n: ++n,
      tabela: "nerus_gateway.notification_control",
      executado: true,
      filtro: `type_notification='invoices' AND user_id=${opts.mlUserId} AND notification_sended LIKE '%${recurso}%'`,
      linhas: notificacoes.length,
      detalhe: notificacao
        ? `id=${celula(notificacao.id)} date_notification=${horarioTabelaEBrasilia(notificacao.date_notification)}`
        : "0 linhas",
    });
  } catch (erro) {
    rastro.push({
      n: ++n,
      tabela: "nerus_gateway.notification_control",
      executado: true,
      filtro: `type_notification='invoices' AND user_id=${opts.mlUserId} AND notification_sended LIKE '%${recurso}%'`,
      linhas: 0,
      detalhe: `ERRO: ${msgConsulta(erro)}`,
    });
  }

  let alvos: Linha[] = [];
  if (!notificacao?.id) {
    rastro.push({
      n: ++n,
      tabela: "nerus_gateway.notification_control_target",
      executado: false,
      filtro: "notification_control_id=?",
      linhas: 0,
      detalhe: "sem notification_control.id",
    });
  } else {
    try {
      alvos = await queryNerus(
        `SELECT id, notification_target_id, notification_control_id, status, retry_count, last_retry
         FROM nerus_gateway.notification_control_target
         WHERE notification_control_id = ?
         ORDER BY last_retry ASC`,
        [String(notificacao.id)],
      );
      rastro.push({
        n: ++n,
        tabela: "nerus_gateway.notification_control_target",
        executado: true,
        filtro: `notification_control_id=${celula(notificacao.id)}`,
        linhas: alvos.length,
        detalhe: alvos.length
          ? alvos
              .map(
                (a) =>
                  `id=${celula(a.id)} status=${String(a.status ?? "").toUpperCase() || "null"} retry_count=${celula(a.retry_count)} last_retry=${horarioTabelaEBrasilia(a.last_retry)}`,
              )
              .join("; ")
          : "0 linhas",
      });
    } catch (erro) {
      rastro.push({
        n: ++n,
        tabela: "nerus_gateway.notification_control_target",
        executado: true,
        filtro: `notification_control_id=${celula(notificacao.id)}`,
        linhas: 0,
        detalhe: `ERRO: ${msgConsulta(erro)}`,
      });
    }
  }

  let invoice: Linha | null = null;
  try {
    const invoices = await queryNerus(
      `SELECT tenant_id, id, external_id, number, serial_number, key_nfe, status,
              channel_status, integrated_at, order_marketplace_id, created_at
       FROM nerus_o2.invoice
       WHERE tenant_id = ? AND external_id = ?
       LIMIT 5`,
      [opts.tenantId, opts.invoiceId],
    );
    invoice = invoices[0] ?? null;
    rastro.push({
      n: ++n,
      tabela: "nerus_o2.invoice",
      executado: true,
      filtro: `tenant_id=${opts.tenantId} AND external_id=${opts.invoiceId}`,
      linhas: invoices.length,
      detalhe: invoice
        ? `id=${celula(invoice.id)} status=${celula(invoice.status)} channel_status=${celula(invoice.channel_status)} key_nfe=${celula(invoice.key_nfe)}`
        : "0 linhas",
    });
  } catch (erro) {
    rastro.push({
      n: ++n,
      tabela: "nerus_o2.invoice",
      executado: true,
      filtro: `tenant_id=${opts.tenantId} AND external_id=${opts.invoiceId}`,
      linhas: 0,
      detalhe: `ERRO: ${msgConsulta(erro)}`,
    });
  }

  const chave = opts.chave || (invoice?.key_nfe ? String(invoice.key_nfe) : "");
  let entregas: Linha[] = [];
  if (!chave) {
    rastro.push({
      n: ++n,
      tabela: "nerus_o2.fiscal_document_deliveries",
      executado: false,
      filtro: `tenant_id=${opts.tenantId} AND document_id=?`,
      linhas: 0,
      detalhe: "sem chave NF-e",
    });
  } else {
    try {
      entregas = await queryNerus(
        `SELECT id, tenant_id, document_id, status, created_at, updated_at
         FROM nerus_o2.fiscal_document_deliveries
         WHERE tenant_id = ? AND document_id = ?
         ORDER BY created_at DESC
         LIMIT 20`,
        [opts.tenantId, chave],
      );
      rastro.push({
        n: ++n,
        tabela: "nerus_o2.fiscal_document_deliveries",
        executado: true,
        filtro: `tenant_id=${opts.tenantId} AND document_id=${chave}`,
        linhas: entregas.length,
        detalhe: entregas.length
          ? entregas
              .map(
                (e) =>
                  `id=${celula(e.id)} status=${String(e.status ?? "").toUpperCase() || "null"} created_at=${horarioTabelaEBrasilia(e.created_at)} updated_at=${horarioTabelaEBrasilia(e.updated_at)}`,
              )
              .join("; ")
          : "0 linhas",
      });
    } catch (erro) {
      rastro.push({
        n: ++n,
        tabela: "nerus_o2.fiscal_document_deliveries",
        executado: true,
        filtro: `tenant_id=${opts.tenantId} AND document_id=${chave}`,
        linhas: 0,
        detalhe: `ERRO: ${msgConsulta(erro)}`,
      });
    }
  }

  return { notificacao, alvos, invoice, entregas, rastro };
}

export async function diagnosticarNota(opts: {
  invoiceId: string;
  chave?: string | null;
  numero: number;
  serie: number;
  mlUserId?: string;
  executarContigencia?: boolean;
}): Promise<RelatorioDiagnostico> {
  const invoiceId = String(opts.invoiceId);
  const mlUserId = opts.mlUserId || process.env.ML_USER_ID?.trim();
  if (!mlUserId) throw new Error("Defina ML_USER_ID no .env");
  const tenantId = process.env.NERUS_TENANT_ID?.trim();
  if (!tenantId) throw new Error("Defina NERUS_TENANT_ID no .env");
  const applicationId =
    process.env.ML_APPLICATION_ID?.trim() || process.env.ML_CLIENT_ID?.trim() || "";
  const referencia = `${opts.numero}/${opts.serie}`;

  const estado = await consultarEstadoNerus({
    invoiceId,
    chave: opts.chave,
    mlUserId,
    tenantId,
  });

  const chave = opts.chave ?? (estado.invoice?.key_nfe ? String(estado.invoice.key_nfe) : null);
  const passos = montarPassos({
    notificacao: estado.notificacao,
    alvos: estado.alvos,
    invoice: estado.invoice,
    entregas: estado.entregas,
  });
  const entrega = classificarEntregas(estado.entregas);

  const falha = erroDeConsulta(estado.rastro);
  const decisao = falha
    ? {
        diagnostico: `A consulta ao Nerus falhou em ${falha.tabela}. Contingência não disparada para não agir no escuro.`,
        precisaAdmin: true,
        proximaAcao: "nenhuma" as const,
      }
    : decidirAcao(estado);
  let contigencia: RelatorioDiagnostico["contigencia"] = null;

  if (decisao.proximaAcao === "contigencia" && opts.executarContigencia !== false) {
    try {
      if (!applicationId) throw new Error("Defina ML_APPLICATION_ID ou ML_CLIENT_ID no .env");
      contigencia = await renotificarInvoice({ invoiceId, mlUserId, applicationId });
      passos.push({
        id: "contigencia",
        titulo: "Contingência",
        status: "ok",
        detalhe: "Aviso reenviado ao sistema.",
      });
    } catch (erro) {
      passos.push({
        id: "contigencia",
        titulo: "Contingência",
        status: "erro",
        detalhe: erro instanceof Error ? erro.message : String(erro),
      });
      decisao.precisaAdmin = true;
    }
  }

  const rastro = [...estado.rastro];
  const recurso = `/users/${mlUserId}/invoices/${invoiceId}`;
  const passoContigencia = passos.find((p) => p.id === "contigencia");
  if (contigencia) {
    rastro.push({
      n: rastro.length + 1,
      tabela: "POST contingência (topic=invoices)",
      executado: true,
      filtro: `resource=${recurso}`,
      linhas: 1,
      detalhe: `HTTP ${contigencia.httpStatus} notification_id=${contigencia.notificationId}`,
    });
  } else if (passoContigencia?.status === "erro") {
    rastro.push({
      n: rastro.length + 1,
      tabela: "POST contingência (topic=invoices)",
      executado: true,
      filtro: `resource=${recurso}`,
      linhas: 0,
      detalhe: `ERRO: ${passoContigencia.detalhe}`,
    });
  } else if (decisao.proximaAcao === "contigencia") {
    rastro.push({
      n: rastro.length + 1,
      tabela: "POST contingência (topic=invoices)",
      executado: false,
      filtro: `resource=${recurso}`,
      linhas: 0,
      detalhe: "não disparada neste ciclo",
    });
  } else {
    rastro.push({
      n: rastro.length + 1,
      tabela: "POST contingência (topic=invoices)",
      executado: false,
      filtro: `resource=${recurso}`,
      linhas: 0,
      detalhe: "não disparada (não era falta de aviso do ML)",
    });
  }

  const base = {
    referencia,
    invoiceId,
    chave,
    numero: opts.numero,
    serie: opts.serie,
    notificacaoRecebida: Boolean(estado.notificacao),
    entregaEnviada: entrega === "enviada",
    precisaAdmin: decisao.precisaAdmin,
    proximaAcao: decisao.proximaAcao,
    diagnostico: decisao.diagnostico,
    passos,
    notificacao: soCampos(estado.notificacao, ["id", "user_id", "type_notification", "date_notification"]),
    alvos: estado.alvos,
    invoice: soCampos(estado.invoice, [
      "id",
      "external_id",
      "number",
      "serial_number",
      "key_nfe",
      "status",
      "channel_status",
      "integrated_at",
      "order_marketplace_id",
    ]),
    entregas: estado.entregas,
    contigencia,
    rastro,
  };

  const final = concluirRelatorio(base);
  return {
    ...base,
    precisaAdmin: final.precisaAdmin,
    assunto: final.assunto,
    mensagem: final.mensagem,
  };
}
