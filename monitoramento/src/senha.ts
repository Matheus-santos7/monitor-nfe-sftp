// Gera a linha de uma conta do painel para PAINEL_USUARIOS.
//   npm run senha -- <usuario> <leitura|operacao>
//   (no servidor) docker compose exec api node dist/senha.js <usuario> <leitura|operacao>
// A senha é pedida no terminal (sem eco), nunca por argumento: argumento fica no histórico do shell.
import { createInterface } from "node:readline";
import { gerarLinhaConta, type Papel } from "./sessao.js";

function perguntarSenha(pergunta: string): Promise<string> {
  return new Promise((ok) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const escrever = (rl as unknown as { _writeToOutput: (s: string) => void });
    escrever._writeToOutput = (s: string) => {
      if (s.includes(pergunta)) process.stdout.write(s); // só a pergunta; o que se digita não aparece
    };
    rl.question(pergunta, (resposta) => {
      rl.close();
      process.stdout.write("\n");
      ok(resposta);
    });
  });
}

async function main(): Promise<void> {
  const [usuario, papel] = process.argv.slice(2);
  if (!usuario || (papel !== "leitura" && papel !== "operacao")) {
    console.error("uso: npm run senha -- <usuario> <leitura|operacao>");
    process.exit(2);
  }
  const senha = await perguntarSenha(`Senha para ${usuario} (mín. 12 caracteres): `);
  const confirmacao = await perguntarSenha("Repita a senha: ");
  if (senha !== confirmacao) {
    console.error("As senhas não conferem.");
    process.exit(1);
  }
  const linha = await gerarLinhaConta(usuario, papel as Papel, senha);
  console.log("\nAcrescente em PAINEL_USUARIOS no .env (contas separadas por vírgula) e recrie a api:\n");
  console.log(linha);
}

main().catch((erro) => {
  console.error(erro instanceof Error ? erro.message : String(erro));
  process.exit(1);
});
