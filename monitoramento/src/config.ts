import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { AppConfig } from "./types.js";

export function identificadorCliente(config: AppConfig): string {
  return `Cliente: ${config.cliente.nome} - Conta ${config.cliente.conta}`;
}

export function carregarConfig(caminho = process.env.CONFIG_PATH ?? "config.yml"): AppConfig {
  const arquivo = resolve(caminho);
  const bruto = parse(readFileSync(arquivo, "utf8")) as AppConfig;

  if (!bruto?.cliente?.nome || !bruto?.cliente?.conta) {
    throw new Error("config.yml: informe cliente.nome e cliente.conta");
  }
  if (!bruto.sftp?.host || !bruto.sftp?.usuario || !bruto.sftp?.senha) {
    throw new Error("config.yml: informe sftp.host, sftp.usuario e sftp.senha");
  }
  if (!Array.isArray(bruto.series) || bruto.series.length === 0) {
    throw new Error("config.yml: informe ao menos uma série em series[]");
  }

  for (const serie of bruto.series) {
    if (!Number.isInteger(serie.numero) || serie.numero < 1) {
      throw new Error("config.yml: series[].numero deve ser inteiro >= 1");
    }
    if (!Number.isInteger(serie.nota_inicial) || serie.nota_inicial < 1) {
      throw new Error(`config.yml: nota_inicial da série ${serie.numero} deve ser inteiro >= 1`);
    }
  }

  return {
    cliente: {
      nome: String(bruto.cliente.nome),
      conta: String(bruto.cliente.conta),
      canal: bruto.cliente.canal ?? "Mercado Livre",
    },
    sftp: {
      host: String(bruto.sftp.host),
      porta: Number(bruto.sftp.porta ?? 22),
      usuario: String(bruto.sftp.usuario),
      senha: String(bruto.sftp.senha),
      diretorios: bruto.sftp.diretorios?.length
        ? bruto.sftp.diretorios.map(String)
        : ["/xml-nerus", "/xml-nerus/Transferidos"],
      ip_origem: bruto.sftp.ip_origem ? String(bruto.sftp.ip_origem) : undefined,
    },
    series: bruto.series.map((s) => ({
      numero: Number(s.numero),
      nota_inicial: Number(s.nota_inicial),
    })),
    webhooks: {
      google_chat: bruto.webhooks?.google_chat || undefined,
      painel: bruto.webhooks?.painel || undefined,
      painel_token: bruto.webhooks?.painel_token
        ? String(bruto.webhooks.painel_token)
        : undefined,
    },
    agendamento: bruto.agendamento || undefined,
    executar_ao_iniciar: Boolean(bruto.executar_ao_iniciar),
    http: {
      porta: Number(bruto.http?.porta ?? process.env.PORT ?? 8080),
      token: bruto.http?.token ? String(bruto.http.token) : undefined,
    },
  };
}
