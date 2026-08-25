export type SerieConfig = {
  numero: number;
  nota_inicial: number;
};

export type AppConfig = {
  cliente: {
    nome: string;
    conta: string;
    canal: string;
  };
  sftp: {
    host: string;
    porta: number;
    usuario: string;
    senha: string;
    diretorios: string[];
    ip_origem?: string;
  };
  series: SerieConfig[];
  webhooks: {
    google_chat?: string;
    painel?: string;
    painel_token?: string;
  };
  agendamento?: string;
  executar_ao_iniciar?: boolean;
  http?: {
    porta?: number;
    token?: string;
  };
};

export type Pulo = {
  inicio: number;
  fim: number;
  qtd: number;
};

export type TetoMl = {
  invoiceId: string;
  chave: string;
  numero: number;
  serie: number;
};

export type ResultadoSerie = {
  serie: number;
  cnpj: string;
  total: number;
  min: number;
  max: number;
  pulos: Pulo[];
  totalAusentes: number;
  /** Última NF autorizada no relatório ML do período. null = não consultado / série sem emissão na janela. */
  tetoMl?: number | null;
  ultimaMl?: TetoMl | null;
  /** false = última do ML ainda não está no FTP. null = teto desconhecido. */
  ultimaMlNoFtp?: boolean | null;
};

export type NotaPendente = {
  numero: number;
  serie: number;
};

export type GoogleChatCardsV2 = {
  cardsV2: Array<{
    cardId: string;
    card: {
      header: { title: string; subtitle: string };
      sections: Array<{
        header: string;
        collapsible: boolean;
        uncollapsibleWidgetsCount: number;
        widgets: Array<{
          decoratedText: {
            startIcon: { knownIcon: string };
            text: string;
            bottomLabel: string;
          };
        }>;
      }>;
    };
  }>;
};

export type GoogleChatOk = {
  text: string;
};

export type GoogleChatPayload = GoogleChatCardsV2 | GoogleChatOk;

export type EventoPainel = {
  identificador: string;
  status: "ok" | "alerta";
  mensagem?: string;
  notas: Array<{ texto: string; data: string }>;
  recebidoEm: string;
};
