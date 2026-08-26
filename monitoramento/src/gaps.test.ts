import assert from "node:assert/strict";
import { test } from "node:test";
import { extrairInutilizacao, partesDaChave } from "./chave.js";
import { analisarSeries, calcularPulos, expandirNotas, integracaoCompleta, parseFakeNota } from "./gaps.js";
import { montarEventoPainel, montarPayload } from "./webhook.js";
import type { AppConfig } from "./types.js";

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

test("payload de erro usa cardsV2 no formato pedido", () => {
  const config: AppConfig = {
    cliente: { nome: "Atlas", conta: "279642028", canal: "Mercado Livre" },
    sftp: { host: "h", porta: 22, usuario: "u", senha: "s", diretorios: [] },
    series: [{ numero: 5, nota_inicial: 1 }],
    webhooks: {},
  };
  const payload = montarPayload(config, [
    {
      serie: 5,
      cnpj: "x",
      total: 1,
      min: 1,
      max: 10,
      pulos: [{ inicio: 15692, fim: 15692, qtd: 1 }],
      totalAusentes: 1,
    },
  ]);
  assert.ok("cardsV2" in payload);
  if ("cardsV2" in payload) {
    const text = payload.cardsV2[0].card.sections[0].widgets[0].decoratedText.text;
    assert.equal(text, "<b>15692 / 5</b>");
  }
});

test("evento do painel usa identificador do cliente", () => {
  const config: AppConfig = {
    cliente: { nome: "Atlas", conta: "279642028", canal: "Mercado Livre" },
    sftp: { host: "h", porta: 22, usuario: "u", senha: "s", diretorios: [] },
    series: [{ numero: 5, nota_inicial: 1 }],
    webhooks: {},
  };
  const evento = montarEventoPainel(config, [
    {
      serie: 5,
      cnpj: "x",
      total: 1,
      min: 1,
      max: 10,
      pulos: [{ inicio: 15692, fim: 15692, qtd: 1 }],
      totalAusentes: 1,
    },
  ]);
  assert.equal(evento.identificador, "Cliente: Atlas - Conta 279642028");
  assert.equal(evento.status, "alerta");
  assert.equal(evento.notas[0].texto, "15692 / 5");
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

test("payload ok usa o texto do cliente", () => {
  const config: AppConfig = {
    cliente: { nome: "Atlas", conta: "279642028", canal: "Mercado Livre" },
    sftp: { host: "h", porta: 22, usuario: "u", senha: "s", diretorios: [] },
    series: [{ numero: 2, nota_inicial: 2630 }],
    webhooks: {},
  };
  const payload = montarPayload(config, [
    { serie: 2, cnpj: "x", total: 10, min: 2630, max: 2640, pulos: [], totalAusentes: 0 },
  ]);
  assert.deepEqual(payload, {
    text: "✅ Todas as notas foram integradas no FTP (Cliente: Atlas - Conta 279642028).",
  });
});
