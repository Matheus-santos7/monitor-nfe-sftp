import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIMITE_POR_IP,
  LIMITE_POR_USUARIO_IP,
  _zerarLimites,
  conferirSenha,
  cookieSessao,
  criarSessao,
  gerarLinhaConta,
  lerContas,
  lerCookie,
  lerSessao,
  LIMITE_GLOBAL_POR_MIN,
  bearerBloqueado,
  chaveIp,
  comVagaScrypt,
  liberarTentativa,
  registrarFalhaBearer,
  reservarTentativa,
  usuarioParaLog,
} from "./sessao.js";
import { upsertLinhaEnv } from "./ml-auth.js";

const SEG = "x".repeat(40);
const SENHA = "senha-bem-longa-123";

test("conta: linha sem '$' (compose interpolaria) e senha confere; errada ou usuário inexistente não", async () => {
  const linha = await gerarLinhaConta("ana.time", "operacao", SENHA);
  assert.match(linha, /^ana\.time:operacao:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.ok(!linha.includes("$"));
  const contas = lerContas(linha);
  assert.equal((await conferirSenha(contas, "ana.time", SENHA))?.papel, "operacao");
  assert.equal(await conferirSenha(contas, "ana.time", "errada-errada-123"), null);
  assert.equal(await conferirSenha(contas, "nao-existe", SENHA), null);
});

test("conta: senha curta e usuário inválido são recusados; entrada malformada é ignorada", async () => {
  await assert.rejects(gerarLinhaConta("ana", "leitura", "curta"));
  await assert.rejects(gerarLinhaConta("Ana Maria", "leitura", SENHA));
  const boa = await gerarLinhaConta("cliente", "leitura", SENHA);
  const contas = lerContas(`${boa}, lixo:admin:zz:zz, outro:leitura`);
  assert.deepEqual([...contas.keys()], ["cliente"]);
});

test("sessão: válida, expirada, adulterada, conta removida e senha trocada", async () => {
  const contas = lerContas(await gerarLinhaConta("cliente", "leitura", SENHA));
  const t0 = Date.now();
  const tok = criarSessao(contas.get("cliente")!, SEG, t0, 60_000);
  assert.deepEqual(lerSessao(tok, contas, SEG, t0 + 1000), { usuario: "cliente", papel: "leitura" });
  assert.equal(lerSessao(tok, contas, SEG, t0 + 60_000), null, "expirada");
  assert.equal(lerSessao(tok, contas, "y".repeat(40), t0), null, "outro segredo");
  const [dados, sig] = tok.split(".");
  const forjado = Buffer.from(JSON.stringify({ u: "cliente", exp: t0 + 9e9, fp: "x" })).toString("base64url");
  assert.equal(lerSessao(`${forjado}.${sig}`, contas, SEG, t0), null, "dados trocados, assinatura velha");
  assert.equal(lerSessao(`${dados}.${sig}x`, contas, SEG, t0), null, "assinatura adulterada");
  assert.equal(lerSessao(tok, new Map(), SEG, t0), null, "conta removida");
  const novaSenha = lerContas(await gerarLinhaConta("cliente", "leitura", "outra-senha-longa-456"));
  assert.equal(lerSessao(tok, novaSenha, SEG, t0), null, "senha trocada derruba a sessão");
});

test("sessão: o papel vem da conta atual (rebaixar para leitura vale na hora)", async () => {
  const op = await gerarLinhaConta("bia", "operacao", SENHA);
  const contas = lerContas(op);
  const tok = criarSessao(contas.get("bia")!, SEG);
  const rebaixada = lerContas(op.replace(":operacao:", ":leitura:"));
  assert.equal(lerSessao(tok, rebaixada, SEG)?.papel, "leitura");
});

test("cookie: HttpOnly, Secure, SameSite=Strict; leitura do header Cookie", () => {
  const c = cookieSessao("abc");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=43200"]) assert.ok(c.includes(flag), flag);
  assert.equal(lerCookie("a=1; monitor_sessao=abc.def; b=2"), "abc.def");
  assert.equal(lerCookie("a=1"), null);
  assert.equal(lerCookie(undefined), null);
});

test("limite: reserva antes do scrypt — rajada em paralelo não passa de 5 por usuário+IP; outro IP não trava", () => {
  _zerarLimites();
  const t = Date.now();
  const aceitas = Array.from({ length: 50 }, () => reservarTentativa("1.1.1.1", "cliente", t)).filter(Boolean).length;
  assert.equal(aceitas, LIMITE_POR_USUARIO_IP, "50 simultâneas: só 5 chegam ao scrypt");
  assert.equal(reservarTentativa("2.2.2.2", "cliente", t), true, "atacante noutro IP não trava o cliente");
  assert.equal(reservarTentativa("1.1.1.1", "cliente", t + 15 * 60_000), true, "janela de 15 min passa");
});

test("limite: sucesso devolve a tentativa; 20 por IP; IPv6 agrupado por /64; teto global por minuto", () => {
  _zerarLimites();
  const t = Date.now();
  for (let i = 0; i < 10; i++) {
    assert.equal(reservarTentativa("9.9.9.9", "ana", t), true);
    liberarTentativa("9.9.9.9", "ana", t); // login certo não acumula
  }
  _zerarLimites();
  for (let i = 0; i < LIMITE_POR_IP; i++) reservarTentativa("3.3.3.3", `u${i}`, t);
  assert.equal(reservarTentativa("3.3.3.3", "qualquer", t), false, "varredura de usuários a partir de um IP");
  _zerarLimites();
  assert.equal(chaveIp("2001:db8:1:2:aaaa::1"), chaveIp("2001:db8:1:2:bbbb::9"), "mesmo /64");
  assert.equal(chaveIp("::ffff:10.0.0.1"), "10.0.0.1");
  for (let i = 0; i < LIMITE_POR_IP; i++) reservarTentativa(`2001:db8:1:2::${i + 1}`, `u${i}`, t);
  assert.equal(reservarTentativa("2001:db8:1:2::ffff", "x", t), false, "trocar de IP dentro do /64 não adianta");
  _zerarLimites();
  for (let i = 0; i < LIMITE_GLOBAL_POR_MIN; i++) reservarTentativa(`10.0.${Math.floor(i / 200)}.${i % 200}`, "u", t);
  assert.equal(reservarTentativa("8.8.8.8", "novo", t), false, "teto global: ataque distribuído");
  assert.equal(reservarTentativa("8.8.8.8", "novo", t + 60_000), true, "teto global zera a cada minuto");
});

test("limite: Bearer errado conta por IP", () => {
  _zerarLimites();
  for (let i = 0; i < LIMITE_POR_IP; i++) registrarFalhaBearer("4.4.4.4");
  assert.equal(bearerBloqueado("4.4.4.4"), true);
  assert.equal(bearerBloqueado("5.5.5.5"), false);
});

test("scrypt: no máximo 3 ao mesmo tempo (o resto recebe 'ocupado')", async () => {
  let soltar!: () => void;
  const trava = new Promise<void>((ok) => (soltar = ok));
  const lentas = [1, 2, 3].map(() => comVagaScrypt(() => trava.then(() => "ok")));
  assert.equal(await comVagaScrypt(async () => "ok"), "ocupado");
  soltar();
  assert.deepEqual(await Promise.all(lentas), ["ok", "ok", "ok"]);
  assert.equal(await comVagaScrypt(async () => "ok"), "ok", "vagas devolvidas");
});

test("log: usuário fora do formato (ex.: senha digitada no campo, quebra de linha) vira '?'", () => {
  assert.equal(usuarioParaLog("ana.time"), "ana.time");
  assert.equal(usuarioParaLog("Minh@Senh@123"), "?");
  assert.equal(usuarioParaLog("x\nLogin: admin (operacao)"), "?");
});

test("renovar o token do ML regrava o .env sem estragar PAINEL_USUARIOS", async () => {
  const linha = await gerarLinhaConta("cliente", "leitura", SENHA);
  const env = `MONITOR_HTTP_TOKEN=abc\nPAINEL_USUARIOS=${linha}\nML_REFRESH_TOKEN=velho\n`;
  const novo = upsertLinhaEnv(env, "ML_REFRESH_TOKEN", "TG-novo");
  assert.ok(novo.includes(`PAINEL_USUARIOS=${linha}\n`));
  assert.ok(novo.includes("ML_REFRESH_TOKEN=TG-novo"));
});
