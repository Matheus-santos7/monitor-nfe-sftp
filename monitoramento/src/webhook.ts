import type {
  AppConfig,
  EventoPainel,
  GoogleChatPayload,
  NotaPendente,
  ResultadoSerie,
} from "./types.js";
import { identificadorCliente } from "./config.js";
import { expandirNotas } from "./gaps.js";

const LIMITE_WIDGETS = 40;

function hoje(): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  }).format(new Date());
}

function resumoResultados(resultados: ResultadoSerie[]) {
  const semArquivo = resultados.filter((r) => r.totalAusentes === -1);
  const comFuros = resultados.filter((r) => r.totalAusentes > 0);
  return { semArquivo, comFuros, ok: semArquivo.length === 0 && comFuros.length === 0 };
}

export function montarPayload(
  config: AppConfig,
  resultados: ResultadoSerie[],
): GoogleChatPayload {
  const { semArquivo, comFuros, ok } = resumoResultados(resultados);
  const identificador = identificadorCliente(config);

  if (ok) {
    return {
      text: `✅ Todas as notas foram integradas no FTP (${identificador}).`,
    };
  }

  const notas: NotaPendente[] = expandirNotas(comFuros, LIMITE_WIDGETS);
  const widgets = notas.map((nota) => ({
    decoratedText: {
      startIcon: { knownIcon: "DESCRIPTION" },
      text: `<b>${nota.numero} / ${nota.serie}</b>`,
      bottomLabel: `📅 ${hoje()}`,
    },
  }));

  for (const r of semArquivo) {
    widgets.push({
      decoratedText: {
        startIcon: { knownIcon: "DESCRIPTION" },
        text: `<b>Série ${r.serie} sem XMLs no FTP</b>`,
        bottomLabel: `📅 ${hoje()}`,
      },
    });
  }

  return {
    cardsV2: [
      {
        cardId: "notas-nao-integradas",
        card: {
          header: {
            title: "⚠️ Notas não integradas",
            subtitle: `${config.cliente.canal} • Conta ${config.cliente.conta}`,
          },
          sections: [
            {
              header: "Notas pendentes de integração",
              collapsible: true,
              uncollapsibleWidgetsCount: 5,
              widgets,
            },
          ],
        },
      },
    ],
  };
}

export function montarEventoPainel(
  config: AppConfig,
  resultados: ResultadoSerie[],
): EventoPainel {
  const { semArquivo, comFuros, ok } = resumoResultados(resultados);
  const data = `📅 ${hoje()}`;
  const notas = [
    ...expandirNotas(comFuros, LIMITE_WIDGETS).map((n) => ({
      texto: `${n.numero} / ${n.serie}`,
      data,
    })),
    ...semArquivo.map((r) => ({
      texto: `Série ${r.serie} sem XMLs no FTP`,
      data,
    })),
  ];
  const identificador = identificadorCliente(config);

  return {
    identificador,
    status: ok ? "ok" : "alerta",
    mensagem: ok
      ? `✅ Todas as notas do Mercado Livre foram integradas no Nérus (${identificador}).`
      : undefined,
    notas,
    recebidoEm: new Date().toISOString(),
  };
}

async function postar(
  nome: string,
  url: string,
  body: unknown,
  token?: string,
): Promise<void> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const resposta = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!resposta.ok) {
      const texto = await resposta.text().catch(() => "");
      console.error(`${nome}: HTTP ${resposta.status} ${texto.slice(0, 300)}`);
      return;
    }
    console.log(`${nome}: enviado.`);
  } catch (erro) {
    console.error(`${nome}: falhou — ${erro instanceof Error ? erro.message : String(erro)}`);
  }
}

export async function enviarWebhooks(
  config: AppConfig,
  chat: GoogleChatPayload,
  painel: EventoPainel,
): Promise<void> {
  if (config.webhooks.google_chat) {
    await postar("Google Chat", config.webhooks.google_chat, chat);
  }

  if (config.webhooks.painel) {
    await postar(
      `Painel (${painel.identificador})`,
      config.webhooks.painel,
      painel,
      config.webhooks.painel_token,
    );
  }
}
