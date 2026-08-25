import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import type { AppConfig } from "./types.js";

function hostDeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function resolver(host: string): Promise<string> {
  try {
    const { address } = await lookup(host);
    return address;
  } catch {
    return "(não resolvido)";
  }
}

function ipsLocais(): string[] {
  const nets = networkInterfaces();
  const ips: string[] = [];
  for (const lista of Object.values(nets)) {
    for (const info of lista ?? []) {
      if (info.family === "IPv4" && !info.internal) ips.push(info.address);
    }
  }
  return ips;
}

export async function logarDestinosFirewall(config: AppConfig): Promise<void> {
  const sftpIp = await resolver(config.sftp.host);
  const chatHost = hostDeUrl(config.webhooks.google_chat);
  const painelHost = hostDeUrl(config.webhooks.painel);
  const origem = ipsLocais();

  console.log("");
  console.log("======== Liberação de firewall ========");
  console.log(`SFTP (arquivos XML):     ${config.sftp.host}:${config.sftp.porta}  →  ${sftpIp}`);
  if (chatHost) {
    console.log(`Webhook Google Chat:     ${chatHost}`);
  }
  if (painelHost) {
    console.log(`Painel de monitoria:     ${painelHost}`);
  }
  console.log(`IP de origem (container): ${origem.join(", ") || "(nenhum IPv4 detectado)"}`);
  if (config.sftp.ip_origem) {
    console.log(`Bind VPN (ip_origem):    ${config.sftp.ip_origem}`);
  }
  console.log("Libere saída deste container para os destinos acima (TCP 22 e 443).");
  console.log("========================================");
  console.log("");
}
