import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import { autorizado, lerLote, lerNotas } from "./http.js";

const req = (headers: Record<string, string> = {}) => ({ headers }) as unknown as IncomingMessage;

test("autorizado: sem token configurado nega tudo (POST /ciclo dispara contingência real)", () => {
  assert.equal(autorizado(req({ authorization: "Bearer " }), undefined), false);
  assert.equal(autorizado(req(), ""), false);
});

test("autorizado: Bearer e X-Token; ?token= só vale no /painel", () => {
  assert.equal(autorizado(req({ authorization: "Bearer s3gredo" }), "s3gredo"), true);
  assert.equal(autorizado(req({ "x-token": "s3gredo" }), "s3gredo"), true);
  assert.equal(autorizado(req({ authorization: "Bearer errado" }), "s3gredo"), false);
  assert.equal(autorizado(req(), "s3gredo", new URL("http://x/painel?token=s3gredo")), true);
  assert.equal(autorizado(req(), "s3gredo", new URL("http://x/ciclo?token=s3gredo")), false);
});

test("lerNotas: aceita inteiros positivos e rejeita o resto", () => {
  assert.deepEqual(lerNotas([{ numero: 10, serie: 2 }]), [{ numero: 10, serie: 2 }]);
  for (const ruim of [[], null, "x", [null], [{}], [{ numero: 0, serie: 2 }], [{ numero: -1, serie: 2 }], [{ numero: 1.5, serie: 2 }], [{ numero: "10", serie: 2 }], [{ numero: true, serie: 2 }]]) {
    assert.equal(lerNotas(ruim), null, JSON.stringify(ruim));
  }
  assert.equal(lerNotas(Array.from({ length: 501 }, (_, i) => ({ numero: i + 1, serie: 1 }))), null);
});

test("lerLote: item malformado é recusado; campos de tipo errado não passam", () => {
  assert.equal(lerLote("x"), null);
  assert.equal(lerLote([null]), null);
  assert.equal(lerLote([{ numero: 1 }]), null);
  assert.deepEqual(lerLote([]), []);
  const [i] = lerLote([{ numero: 10, serie: 2, proximaAcao: "rm -rf", diagnostico: 5, passos: [null, { id: "x", status: "hack" }], invoiceId: 7 }])!;
  assert.equal(i.referencia, "10/2");
  assert.equal(i.proximaAcao, "nenhuma");
  assert.equal(i.diagnostico, "");
  assert.equal(i.invoiceId, null);
  assert.deepEqual(i.passos, [{ id: "x", titulo: "", status: "info", detalhe: "" }]);
});
