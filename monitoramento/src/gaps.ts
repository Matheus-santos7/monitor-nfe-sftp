import { MODELO_NFE, extrairChaveDoNome, extrairInutilizacao, partesDaChave } from "./chave.js";
import type { Pulo, ResultadoSerie, SerieConfig, TetoMl } from "./types.js";

export function calcularPulos(numeros: number[], notaMinima: number, teto?: number | null): Pulo[] {
  const lista = [...new Set(numeros)].filter((n) => n >= notaMinima).sort((a, b) => a - b);
  const limite =
    teto != null && Number.isFinite(teto) && teto >= notaMinima ? teto : lista.at(-1);
  if (limite == null) return [];

  const presentes = new Set(lista.filter((n) => n <= limite));
  const pulos: Pulo[] = [];
  let inicioFuro: number | null = null;

  for (let n = notaMinima; n <= limite; n++) {
    if (presentes.has(n)) {
      if (inicioFuro != null) {
        pulos.push({ inicio: inicioFuro, fim: n - 1, qtd: n - inicioFuro });
        inicioFuro = null;
      }
    } else if (inicioFuro == null) {
      inicioFuro = n;
    }
  }
  if (inicioFuro != null) {
    pulos.push({ inicio: inicioFuro, fim: limite, qtd: limite - inicioFuro + 1 });
  }
  return pulos;
}

export function agruparDocumentos(
  arquivos: string[],
): Map<string, number[]> {
  const mapa = new Map<string, number[]>();

  const adicionar = (cnpj: string, serie: number, numero: number) => {
    const chave = `${cnpj}:${serie}`;
    const atual = mapa.get(chave) ?? [];
    atual.push(numero);
    mapa.set(chave, atual);
  };

  for (const arquivo of arquivos) {
    if (!arquivo.toLowerCase().endsWith(".xml")) continue;

    const inut = extrairInutilizacao(arquivo);
    if (inut) {
      for (let n = inut.nIni; n <= inut.nFin; n++) {
        adicionar(inut.cnpj, inut.serie, n);
      }
      continue;
    }

    const chave = extrairChaveDoNome(arquivo);
    if (!chave) continue;
    const partes = partesDaChave(chave);
    if (partes.modelo !== MODELO_NFE) continue;
    adicionar(partes.cnpj, partes.serie, partes.numero);
  }

  return mapa;
}

export function analisarSeries(
  arquivos: string[],
  series: SerieConfig[],
  tetos?: Map<number, TetoMl>,
): ResultadoSerie[] {
  const agrupado = agruparDocumentos(arquivos);
  const desejadas = new Set(series.map((s) => s.numero));
  const porSerie = new Map<number, { cnpj: string; numeros: number[] }>();

  for (const [chave, numeros] of agrupado) {
    const [cnpj, serieStr] = chave.split(":");
    const serie = Number(serieStr);
    if (!desejadas.has(serie)) continue;
    const atual = porSerie.get(serie);
    if (atual) {
      atual.numeros.push(...numeros);
    } else {
      porSerie.set(serie, { cnpj, numeros: [...numeros] });
    }
  }

  return series.map((cfg) => {
    const encontrado = porSerie.get(cfg.numero);
    const numeros = encontrado?.numeros ?? [];
    const lista = [...new Set(numeros)].filter((n) => n >= cfg.nota_inicial).sort((a, b) => a - b);
    const teto = tetos?.get(cfg.numero) ?? null;
    const semArquivos = lista.length === 0;
    const pulosFinais = semArquivos ? [] : calcularPulos(lista, cfg.nota_inicial, teto?.numero ?? null);

    return {
      serie: cfg.numero,
      cnpj: encontrado?.cnpj ?? "",
      total: lista.length,
      min: lista[0] ?? cfg.nota_inicial,
      max: lista.at(-1) ?? cfg.nota_inicial,
      pulos: pulosFinais,
      totalAusentes: semArquivos
        ? -1
        : pulosFinais.reduce((acc, p) => acc + p.qtd, 0),
      tetoMl: teto?.numero ?? null,
      ultimaMl: teto,
      ultimaMlNoFtp: teto ? lista.includes(teto.numero) : null,
    };
  });
}

export function expandirNotas(resultados: ResultadoSerie[], limite?: number): {
  numero: number;
  serie: number;
}[] {
  const notas: { numero: number; serie: number }[] = [];
  for (const r of resultados) {
    for (const pulo of r.pulos) {
      for (let n = pulo.inicio; n <= pulo.fim; n++) {
        notas.push({ numero: n, serie: r.serie });
        if (limite != null && notas.length >= limite) return notas;
      }
    }
  }
  return notas;
}

export const TOLERANCIA_PADRAO_MIN = 20;

/** Minutos de tolerância (TOLERANCIA_MIN, padrão 20): nota ausente há menos que isso está "em trânsito". */
export function toleranciaMin(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.TOLERANCIA_MIN);
  return Number.isFinite(v) && v >= 0 ? v : TOLERANCIA_PADRAO_MIN;
}

/**
 * Separa as notas ausentes em furos (ausentes há ≥ tolerância) e em trânsito (ainda podem chegar: atraso normal
 * de integração). A idade vem de `ausentesDesde` (1ª checagem que viu a nota faltar). Nota nunca vista antes
 * conta a partir de agora: a tolerância pode atrasar o primeiro alerta, nunca esconder o furo.
 */
export function separarEmTransito(
  notas: { numero: number; serie: number }[],
  ausentesDesde: Record<string, string>,
  agora: Date,
  tolerancia: number,
): { furos: { numero: number; serie: number }[]; emTransito: { numero: number; serie: number; haMin: number }[] } {
  const furos: { numero: number; serie: number }[] = [];
  const emTransito: { numero: number; serie: number; haMin: number }[] = [];
  for (const n of notas) {
    const desde = ausentesDesde[`${n.numero}/${n.serie}`];
    const ms = desde ? agora.getTime() - new Date(desde).getTime() : 0;
    const haMin = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0;
    if (haMin >= tolerancia) furos.push(n);
    else emTransito.push({ ...n, haMin });
  }
  return { furos, emTransito };
}

/** true só quando todas as séries monitoradas têm XML e nenhum furo. */
export function integracaoCompleta(resultados: ResultadoSerie[]): boolean {
  return resultados.length > 0 && resultados.every((r) => r.totalAusentes === 0);
}

/** Formato: 6349/2. Vazio, 0, false, off = desligado (FTP real). */
export function parseFakeNota(raw?: string | null): { numero: number; serie: number } | null {
  const v = String(raw ?? "").trim();
  if (!v || /^(0|false|off|no|desligada|disabled)$/i.test(v)) return null;
  const match = v.match(/^(\d+)\s*[\/,;x-]\s*(\d+)$/i);
  if (!match) return null;
  return { numero: Number(match[1]), serie: Number(match[2]) };
}

export function aplicarFakeNota(
  notasAusentes: { numero: number; serie: number }[],
  integracaoOk: boolean,
  raw?: string | null,
): {
  notasAusentes: { numero: number; serie: number }[];
  integracaoOk: boolean;
  fake: { numero: number; serie: number } | null;
} {
  const fake = parseFakeNota(raw);
  if (!fake) return { notasAusentes, integracaoOk, fake: null };
  const jaTem = notasAusentes.some((n) => n.numero === fake.numero && n.serie === fake.serie);
  return {
    notasAusentes: jaTem ? notasAusentes : [fake, ...notasAusentes],
    integracaoOk: false,
    fake,
  };
}
