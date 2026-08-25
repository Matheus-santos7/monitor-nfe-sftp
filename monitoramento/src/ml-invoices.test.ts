import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listarNomesZip, parseNomeRelatorio, tetosPorSerie, yyyymmddEmTz } from "./ml-invoices.js";

test("parseNomeRelatorio lê invoice_id + NF/série da chave no ZIP", () => {
  const chave = "35260800000000000191550020000063491000000010";
  const nome = `xml/1000000001_${chave}-procNFe.xml`;
  assert.deepEqual(parseNomeRelatorio(nome), {
    invoiceId: "1000000001",
    chave,
    numero: 6349,
    serie: 2,
    xmlNome: nome,
  });
  assert.equal(parseNomeRelatorio("xml/cte-sem-padrao-nfe.xml"), null);
});

test("listarNomesZip lê o diretório central", () => {
  const dir = mkdtempSync(join(tmpdir(), "zip-nfe-"));
  try {
    const inner = join(dir, "xml");
    mkdirSync(inner, { recursive: true });
    const fname = "1000000002_35260800000000000191550020000063811000000010-procNFe.xml";
    writeFileSync(join(inner, fname), "nfe");
    const zipPath = join(dir, "rel.zip");
    const zipped = spawnSync("zip", ["-r", "-q", zipPath, "xml"], { cwd: dir });
    if (zipped.status !== 0) {
      // alpine/mac sem zip: monta um ZIP mínimo na mão via Python
      const py = spawnSync("python3", [
        "-c",
        "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr(sys.argv[2], b'nfe')",
        zipPath,
        `xml/${fname}`,
      ]);
      assert.equal(py.status, 0, String(py.stderr));
    }
    const nomes = listarNomesZip(readFileSync(zipPath));
    assert.ok(nomes.some((n) => n.endsWith(fname)), nomes.join(","));
    const parsed = nomes.map(parseNomeRelatorio).find(Boolean);
    assert.equal(parsed?.invoiceId, "1000000002");
    assert.equal(parsed?.numero, 6381);
    assert.equal(parsed?.serie, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("yyyymmddEmTz formata 8 dígitos", () => {
  const v = yyyymmddEmTz(new Date("2026-08-24T18:00:00-03:00"), "America/Sao_Paulo");
  assert.equal(v, "20260824");
});

test("tetosPorSerie pega o maior número de cada série", () => {
  const tetos = tetosPorSerie([
    { invoiceId: "1", chave: "a", numero: 6348, serie: 2, xmlNome: "a" },
    { invoiceId: "2", chave: "b", numero: 6350, serie: 2, xmlNome: "b" },
    { invoiceId: "3", chave: "c", numero: 40, serie: 8, xmlNome: "c" },
    { invoiceId: "4", chave: "d", numero: 39, serie: 8, xmlNome: "d" },
  ]);
  assert.equal(tetos.get(2)?.invoiceId, "2");
  assert.equal(tetos.get(2)?.numero, 6350);
  assert.equal(tetos.get(8)?.invoiceId, "3");
  assert.equal(tetos.get(8)?.numero, 40);
  assert.equal(tetos.size, 2);
});
