import SftpClient from "ssh2-sftp-client";
import type { AppConfig } from "./types.js";

export async function listarArquivosFtp(config: AppConfig): Promise<string[]> {
  const client = new SftpClient();
  try {
    await client.connect({
      host: config.sftp.host,
      port: config.sftp.porta,
      username: config.sftp.usuario,
      password: config.sftp.senha,
      readyTimeout: 20000,
      ...(config.sftp.ip_origem ? { localAddress: config.sftp.ip_origem } : {}),
    });
    const nomes: string[] = [];
    for (const diretorio of config.sftp.diretorios) {
      try {
        const lista = await client.list(diretorio);
        console.log(`  ${diretorio}: ${lista.length} arquivo(s)`);
        for (const item of lista) {
          nomes.push("name" in item ? item.name : String(item));
        }
      } catch (erro) {
        console.warn(`  ${diretorio}: falha ao listar — ${String(erro)}`);
      }
    }
    return nomes.filter(Boolean);
  } finally {
    await client.end().catch(() => undefined);
  }
}
