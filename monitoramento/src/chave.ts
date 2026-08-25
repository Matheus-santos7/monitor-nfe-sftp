import { basename } from "node:path";

export const MODELO_NFE = "55";

const PADRAO_CHAVE = /(?:NFe|Cte|Canc)[-_](\d{44})\.xml/i;
const PADRAO_INICIO = /^(\d{44})/;
const PADRAO_INUT = /Inut-ID(\d+)\.xml/i;

export type ChavePartes = {
  cnpj: string;
  serie: number;
  numero: number;
  modelo: string;
};

export function partesDaChave(chave: string): ChavePartes {
  return {
    cnpj: chave.slice(6, 20),
    serie: Number(chave.slice(22, 25)),
    numero: Number(chave.slice(25, 34)),
    modelo: chave.slice(20, 22),
  };
}

export function extrairChaveDoNome(nomeArquivo: string): string | undefined {
  const nome = basename(nomeArquivo);
  return PADRAO_CHAVE.exec(nome)?.[1] ?? PADRAO_INICIO.exec(nome)?.[1];
}

export function extrairInutilizacao(
  nomeArquivo: string,
): { cnpj: string; serie: number; nIni: number; nFin: number } | undefined {
  const match = PADRAO_INUT.exec(basename(nomeArquivo));
  if (!match) return undefined;

  const digits = match[1];
  let cnpj: string;
  let modelo: string;
  let serie: string;
  let nIni: number;
  let nFin: number;

  if (digits.length === 43) {
    cnpj = digits.slice(6, 20);
    modelo = digits.slice(20, 22);
    serie = digits.slice(22, 25);
    nIni = Number(digits.slice(25, 34));
    nFin = Number(digits.slice(34, 43));
  } else if (digits.length === 41) {
    cnpj = digits.slice(4, 18);
    modelo = digits.slice(18, 20);
    serie = digits.slice(20, 23);
    nIni = Number(digits.slice(23, 32));
    nFin = Number(digits.slice(32, 41));
  } else {
    return undefined;
  }

  if (modelo !== MODELO_NFE || nIni > nFin) return undefined;
  return { cnpj, serie: Number(serie), nIni, nFin };
}
