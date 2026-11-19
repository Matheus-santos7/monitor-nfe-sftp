import assert from "node:assert/strict";
import { test } from "node:test";
import { extrairInutilizacao, partesDaChave } from "./chave.js";
import { analisarSeries, calcularPulos, expandirNotas, integracaoCompleta, parseFakeNota, separarEmTransito, toleranciaMin } from "./gaps.js";

/** Chave NF-e fictícia (CNPJ 00.000.000/0001-91). */
function chaveNfe(serie: number, numero: number): string {
  return `3526080000000000019155${String(serie).padStart(3, "0")}${String(numero).padStart(9, "0")}1000000010`;
}

function inutNfe(serie: number, numero: number): string {
  const s = String(serie).padStart(3, "0");
  const n = String(numero).padStart(9, "0");
  return `Inut-ID${"0000"}${"00000000000191"}55${s}${n}${n}.xml`;
}

test("FAKE_NOTA vazio ou off não força furo; 1000/1 força", () => {
  assert.equal(parseFakeNota(""), null);
  assert.equal(parseFakeNota("false"), null);
  assert.equal(parseFakeNota("off"), null);
  assert.deepEqual(parseFakeNota("1000/1"), { numero: 1000, serie: 1 });
  assert.deepEqual(parseFakeNota("1000-1"), { numero: 1000, serie: 1 });
});

test("inutilização 41 dígitos — série 8 nota 35", () => {
  const r = extrairInutilizacao(inutNfe(8, 35));
  assert.deepEqual(r, {
    cnpj: "00000000000191",
    serie: 8,
    nIni: 35,
    nFin: 35,
  });
});

test("gaps entre notas com piso", () => {
  const pulos = calcularPulos([2630, 2631, 2633], 2630);
  assert.deepEqual(pulos, [{ inicio: 2632, fim: 2632, qtd: 1 }]);
});

test("teto ML inclui o furo no fim (FTP atrás da última emitida)", () => {
  const pulos = calcularPulos([2630, 2631, 2633], 2630, 2635);
  assert.deepEqual(pulos, [
    { inicio: 2632, fim: 2632, qtd: 1 },
    { inicio: 2634, fim: 2635, qtd: 2 },
  ]);
});

test("teto ML ignora furos do FTP depois da última emitida pelo ML", () => {
  const pulos = calcularPulos([2630, 2631, 2633, 2635], 2630, 2631);
  assert.deepEqual(pulos, []);
});

test("analisa só as séries configuradas e expande notas", () => {
  const chaveS2 = chaveNfe(2, 2630);
  assert.equal(partesDaChave(chaveS2).serie, 2);
  assert.equal(partesDaChave(chaveS2).numero, 2630);

  const arquivos = [
    `NFe-${chaveS2}.xml`,
    `NFe-${chaveNfe(2, 2631)}.xml`,
    `NFe-${chaveNfe(2, 2633)}.xml`,
    inutNfe(8, 31),
    inutNfe(8, 32),
  ];
  const resultados = analisarSeries(arquivos, [
    { numero: 2, nota_inicial: 2630 },
    { numero: 8, nota_inicial: 31 },
  ]);
  const s2 = resultados.find((r) => r.serie === 2)!;
  const s8 = resultados.find((r) => r.serie === 8)!;
  assert.equal(s2.totalAusentes, 1);
  assert.equal(s8.totalAusentes, 0);
  assert.equal(s2.tetoMl, null);
  assert.equal(s2.ultimaMlNoFtp, null);
  assert.deepEqual(expandirNotas([s2]), [{ numero: 2632, serie: 2 }]);
});

test("expandirNotas lista todos os furos; limite opcional só para cards", () => {
  const base = {
    serie: 2,
    cnpj: "x",
    total: 1,
    min: 1,
    max: 60,
    pulos: [{ inicio: 1, fim: 50, qtd: 50 }],
    totalAusentes: 50,
  };
  assert.equal(expandirNotas([base]).length, 50);
  assert.equal(expandirNotas([base], 10).length, 10);
  assert.equal(expandirNotas([base])[49].numero, 50);
});

test("teto ML marca a última emitida ausente no FTP e completa a sequência até ela", () => {
  const arquivos = [
    `NFe-${chaveNfe(2, 2630)}.xml`,
    `NFe-${chaveNfe(2, 2631)}.xml`,
    `NFe-${chaveNfe(2, 2633)}.xml`,
  ];
  const tetos = new Map([
    [
      2,
      {
        invoiceId: "999",
        chave: chaveNfe(2, 2635),
        numero: 2635,
        serie: 2,
        xmlNome: "x",
      },
    ],
  ]);
  const s2 = analisarSeries(arquivos, [{ numero: 2, nota_inicial: 2630 }], tetos)[0];
  assert.equal(s2.max, 2633);
  assert.equal(s2.tetoMl, 2635);
  assert.equal(s2.ultimaMl?.invoiceId, "999");
  assert.equal(s2.ultimaMlNoFtp, false);
  assert.equal(s2.totalAusentes, 3);
  assert.deepEqual(s2.pulos, [
    { inicio: 2632, fim: 2632, qtd: 1 },
    { inicio: 2634, fim: 2635, qtd: 2 },
  ]);
  assert.equal(integracaoCompleta([s2]), false);
});

test("última do ML presente no FTP fecha a sequência até o teto", () => {
  const arquivos = [
    `NFe-${chaveNfe(2, 2630)}.xml`,
    `NFe-${chaveNfe(2, 2631)}.xml`,
  ];
  const tetos = new Map([
    [
      2,
      {
        invoiceId: "111",
        chave: chaveNfe(2, 2631),
        numero: 2631,
        serie: 2,
        xmlNome: "x",
      },
    ],
  ]);
  const s2 = analisarSeries(arquivos, [{ numero: 2, nota_inicial: 2630 }], tetos)[0];
  assert.equal(s2.totalAusentes, 0);
  assert.equal(s2.ultimaMlNoFtp, true);
  assert.equal(integracaoCompleta([s2]), true);
});

test("integração completa exige todas as séries sem furo e com XML", () => {
  assert.equal(
    integracaoCompleta([
      { serie: 2, cnpj: "x", total: 10, min: 1, max: 10, pulos: [], totalAusentes: 0 },
      { serie: 8, cnpj: "x", total: 3, min: 31, max: 33, pulos: [], totalAusentes: 0 },
    ]),
    true,
  );
  assert.equal(
    integracaoCompleta([
      { serie: 2, cnpj: "x", total: 10, min: 1, max: 10, pulos: [], totalAusentes: 0 },
      { serie: 8, cnpj: "x", total: 0, min: 31, max: 31, pulos: [], totalAusentes: -1 },
    ]),
    false,
  );
});

test("separarEmTransito: fronteiras 19/20/21 min, nota sem 'desde' e data inválida", () => {
  const agora = new Date("2026-11-19T15:00:00Z");
  const desde = (min: number) => new Date(agora.getTime() - min * 60_000).toISOString();
  const { furos, emTransito } = separarEmTransito(
    [{ numero: 1, serie: 2 }, { numero: 2, serie: 2 }, { numero: 3, serie: 2 }, { numero: 4, serie: 2 }, { numero: 5, serie: 2 }],
    { "1/2": desde(19), "2/2": desde(20), "3/2": desde(21), "5/2": "lixo" },
    agora,
    20,
  );
  assert.deepEqual(furos.map((n) => n.numero), [2, 3]);
  assert.deepEqual(emTransito.map((n) => [n.numero, n.haMin]), [[1, 19], [4, 0], [5, 0]]);
});

test("toleranciaMin: padrão 20; aceita 0; valor inválido volta ao padrão", () => {
  assert.equal(toleranciaMin({}), 20);
  assert.equal(toleranciaMin({ TOLERANCIA_MIN: "30" }), 30);
  assert.equal(toleranciaMin({ TOLERANCIA_MIN: "0" }), 0);
  assert.equal(toleranciaMin({ TOLERANCIA_MIN: "abc" }), 20);
  assert.equal(toleranciaMin({ TOLERANCIA_MIN: "-5" }), 20);
});
