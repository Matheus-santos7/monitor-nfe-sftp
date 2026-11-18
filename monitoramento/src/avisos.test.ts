import assert from "node:assert/strict";
import { test } from "node:test";
import { canaisDoAmbiente, enviarAviso } from "./avisos.js";

const msg = { assunto: "NF-e 10/2 — resolvido", mensagem: "NF 10/2\n\n✅ Resolvido" };

function fetchFalso(status: Record<string, number> = {}) {
  const chamadas: { url: string; corpo: unknown }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), corpo: JSON.parse(String(init?.body)) });
    return new Response("", { status: status[String(url)] ?? 200 });
  }) as typeof fetch;
  return { f, chamadas };
}

test("canais: só os configurados; Chat e WhatsApp com o mesmo corpo que o n8n enviava", async () => {
  const { f, chamadas } = fetchFalso();
  const emails: unknown[] = [];
  const canais = canaisDoAmbiente(
    {
      GOOGLE_CHAT_WEBHOOK_URL: "https://chat.exemplo/x",
      WHATSAPP_WEBHOOK_URL: "https://zap.exemplo/y",
      WHATSAPP_TO: "5511999999999",
      SMTP_HOST: "smtp.exemplo",
      ALERT_EMAIL_TO: "ops@exemplo.com",
      ALERT_EMAIL_FROM: "monitor@exemplo.com",
    },
    { fetch: f, criarTransporte: () => ({ sendMail: async (m) => void emails.push(m) }) },
  );
  assert.deepEqual(canais.map((c) => c.nome), ["Google Chat", "WhatsApp", "e-mail"]);
  const r = await enviarAviso(msg, canais);
  assert.deepEqual(r.entregues, ["Google Chat", "WhatsApp", "e-mail"]);
  assert.deepEqual(chamadas[0].corpo, { text: msg.mensagem });
  assert.deepEqual(chamadas[1].corpo, { number: "5511999999999", text: msg.mensagem });
  assert.deepEqual(emails[0], { from: "monitor@exemplo.com", to: "ops@exemplo.com", subject: msg.assunto, text: msg.mensagem });
});

test("canais: sem variável o canal é pulado; e-mail exige SMTP_HOST e ALERT_EMAIL_TO", () => {
  const deps = { fetch: fetchFalso().f, criarTransporte: () => ({ sendMail: async () => undefined }) };
  assert.deepEqual(canaisDoAmbiente({}, deps), []);
  assert.deepEqual(canaisDoAmbiente({ ALERT_EMAIL_TO: "ops@exemplo.com" }, deps), []);
  assert.deepEqual(canaisDoAmbiente({ SMTP_HOST: "smtp.exemplo" }, deps), []);
});

test("enviarAviso: um canal com falha não impede os outros e não lança", async () => {
  const { f } = fetchFalso({ "https://chat.exemplo/x": 500 });
  const canais = canaisDoAmbiente(
    { GOOGLE_CHAT_WEBHOOK_URL: "https://chat.exemplo/x", WHATSAPP_WEBHOOK_URL: "https://zap.exemplo/y" },
    { fetch: f, criarTransporte: () => ({ sendMail: async () => undefined }) },
  );
  const r = await enviarAviso(msg, canais);
  assert.deepEqual(r.entregues, ["WhatsApp"]);
  assert.deepEqual(r.falhas, [{ canal: "Google Chat", erro: "HTTP 500" }]);
});
