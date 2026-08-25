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
        "O Mercado Livre não notificou o gateway. Ativar contingência (renotificar) e avisar o admin.",
      precisaAdmin: true,
      proximaAcao: "contigencia",
    };
  }

  const algumSucesso = input.alvos.some((a) => String(a.status ?? "").toUpperCase() === "SUCCESS");
  const algumErro = input.alvos.some((a) => String(a.status ?? "").toUpperCase() === "ERROR");

  if (!input.invoice) {
    return {
      diagnostico: algumSucesso
        ? "A notificação chegou ao gateway, mas a nota não entrou em nerus_o2.invoice."
        : "A notificação chegou, os destinos falharam e a nota não foi integrada.",
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
        "Nota integrada e entrega FTP em SENT (rotina de reenvio já disparou). Rechecar o SFTP para confirmar o XML.",
      precisaAdmin: false,
      proximaAcao: "rechecar_ftp",
    };
  }
  if (entrega === "pendente") {
    return {
      diagnostico: `Nota integrada, mas o controle de envio FTP está ${statusesEntrega || "em andamento"} (não SENT). Aguardar 10 min e reconsultar.`,
      precisaAdmin: true,
      proximaAcao: "esperar_entrega",
    };
  }
  if (entrega === "falhou") {
    return {
      diagnostico: `Nota integrada, mas a entrega FTP está ${statusesEntrega} (não SENT).`,
      precisaAdmin: true,
      proximaAcao: "nenhuma",
    };
  }
  return {
    diagnostico: algumErro
      ? "Nota integrada no Nerus, sem registro de entrega FTP. Houve destino de notificação com ERROR."
      : "Nota integrada no Nerus, mas sem registro em fiscal_document_deliveries.",
    precisaAdmin: true,
    proximaAcao: "nenhuma",
  };
}

function mensagemRelatorio(r: Omit<RelatorioDiagnostico, "assunto" | "mensagem">): string {
  const linhas = [
    `🔎 Diagnóstico NF ${r.referencia} (invoice ${r.invoiceId})`,
    "",
    `Onde está o problema: ${r.diagnostico}`,
    "",
    "Passos:",
    ...r.passos.map((p, i) => (p.detalhe ? `${i + 1}. ${p.titulo} — ${p.detalhe}` : `${i + 1}. ${p.titulo}`)),
  ];
  return linhas.join("\n");
}

function alvosPorOrdemAsc(alvos: Linha[]): Linha[] {
  return [...alvos].sort((a, b) => instanteOrdenacao(a.last_retry) - instanteOrdenacao(b.last_retry));
}

function resumirAlvos(alvos: Linha[]): string {
  if (!alvos.length) return "sem destinos";
  return alvosPorOrdemAsc(alvos)
    .map((a) => `${String(a.status ?? "").toUpperCase()} (${horarioTabelaEBrasilia(a.last_retry)})`)
    .join(", ");
}

function resumirEntregas(entregas: Linha[]): string {
  if (!entregas.length) return "sem linha";
  return entregas
    .map((e) => {
      const status = String(e.status ?? "").trim().toUpperCase() || "?";
      const quando = e.created_at ?? e.updated_at;
      return quando ? `${status} (${horarioTabelaEBrasilia(quando)})` : status;
    })
    .join(", ");
}

export function montarPassos(opts: {
  invoiceId: string;
  chave: string | null;
  notificacao: Linha | null;
  alvos: Linha[];
  invoice: Linha | null;
  entregas: Linha[];
}): Passo[] {
  const chave = opts.chave?.trim() || (opts.invoice?.key_nfe ? String(opts.invoice.key_nfe) : "");
  const notificou = Boolean(opts.notificacao);
  const passos: Passo[] = [
    {
      id: "ml",
      titulo: `Mercado Livre notificou o gateway? ${notificou ? "[ok]" : "[ERRO]"}`,
      status: notificou ? "ok" : "erro",
      detalhe: `invoice_id ${opts.invoiceId} chave completa: ${chave || "(não informada)"}`,
    },
  ];

  if (opts.notificacao) {
    passos.push({
      id: "gateway",
      titulo: "Status da Notificação no gateway? [OK]",
      status: "ok",
      detalhe: `Recebida em ${horarioTabelaEBrasilia(opts.notificacao.date_notification)}\nID ${String(opts.notificacao.id)}`,
    });
  } else {
    passos.push({
      id: "gateway",
      titulo: "Status da Notificação no gateway? [ERRO]",
      status: "erro",
      detalhe: "Nenhum registro em notification_control para este resource.",
    });
  }

  const alvos = alvosPorOrdemAsc(opts.alvos);
  const temErro = alvos.some((a) => String(a.status ?? "").toUpperCase() === "ERROR");
  passos.push({
    id: "alvos",
    titulo: "Status da notificação recebida",
    status: !alvos.length ? "alerta" : temErro ? "alerta" : "ok",
    detalhe: resumirAlvos(alvos),
  });

  if (opts.invoice) {
    passos.push({
      id: "invoice",
      titulo: "Nota no Nerus? SIM",
      status: "ok",
      detalhe: `invoice_id ${String(opts.invoice.id)} status ${String(opts.invoice.status)}`,
    });
  } else {
    passos.push({
      id: "invoice",
      titulo: "Nota no Nerus? NÃO",
      status: "erro",
      detalhe: "Não encontrada em nerus_o2.invoice.",
    });
  }

  const entrega = classificarEntregas(opts.entregas);
  passos.push({
    id: "ftp",
    titulo: "Controle de envio FTP fiscal_document_deliveries",
    status: entrega === "enviada" ? "ok" : entrega === "pendente" ? "alerta" : "erro",
    detalhe: `status: ${resumirEntregas(opts.entregas)}`,
  });

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
}> {
  const recurso = `/users/${opts.mlUserId}/invoices/${opts.invoiceId}`;
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
  const notificacao = notificacoes[0] ?? null;

  let alvos: Linha[] = [];
  if (notificacao?.id) {
    alvos = await queryNerus(
      `SELECT id, notification_target_id, notification_control_id, status, retry_count, last_retry
       FROM nerus_gateway.notification_control_target
       WHERE notification_control_id = ?
       ORDER BY last_retry ASC`,
      [String(notificacao.id)],
    );
  }

  const invoices = await queryNerus(
    `SELECT tenant_id, id, external_id, number, serial_number, key_nfe, status,
            channel_status, integrated_at, order_marketplace_id, created_at
     FROM nerus_o2.invoice
     WHERE tenant_id = ? AND external_id = ?
     LIMIT 5`,
    [opts.tenantId, opts.invoiceId],
  );
  const invoice = invoices[0] ?? null;
  const chave = opts.chave || (invoice?.key_nfe ? String(invoice.key_nfe) : "");

  let entregas: Linha[] = [];
  if (chave) {
    entregas = await queryNerus(
      `SELECT id, tenant_id, document_id, status, created_at, updated_at
       FROM nerus_o2.fiscal_document_deliveries
       WHERE tenant_id = ? AND document_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [opts.tenantId, chave],
    );
  }

  return { notificacao, alvos, invoice, entregas };
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
    invoiceId,
    chave,
    notificacao: estado.notificacao,
    alvos: estado.alvos,
    invoice: estado.invoice,
    entregas: estado.entregas,
  });
  const entrega = classificarEntregas(estado.entregas);

  const decisao = decidirAcao(estado);
  let contigencia: RelatorioDiagnostico["contigencia"] = null;

  if (decisao.proximaAcao === "contigencia" && opts.executarContigencia !== false) {
    try {
      if (!applicationId) throw new Error("Defina ML_APPLICATION_ID ou ML_CLIENT_ID no .env");
      contigencia = await renotificarInvoice({ invoiceId, mlUserId, applicationId });
      passos.push({
        id: "contigencia",
        titulo: "Plano de contingência",
        status: "ok",
        detalhe: `Renotificação enviada (id ${contigencia.notificationId}). Aguardar 1–3 min e reconsultar.`,
      });
    } catch (erro) {
      passos.push({
        id: "contigencia",
        titulo: "Plano de contingência",
        status: "erro",
        detalhe: erro instanceof Error ? erro.message : String(erro),
      });
      decisao.precisaAdmin = true;
    }
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
  };

  return {
    ...base,
    assunto: `NF-e ${referencia} — ${decisao.proximaAcao === "contigencia" ? "sem notificação ML" : "diagnóstico de furo"}`,
    mensagem: mensagemRelatorio(base),
  };
}
