#!/usr/bin/env python3
import json
from copy import deepcopy
from pathlib import Path

p = Path("workflows/monitor-sftp.json")
wf = json.loads(p.read_text())

# --- helpers ---
def node(name):
    return next(x for x in wf["nodes"] if x["name"] == name)

def set_js(name, code):
    node(name)["parameters"]["jsCode"] = code

http_recheck = {
    "method": "POST",
    "url": "http://monitor-sftp:8080/executar",
    "options": {
        "timeout": 180000,
        "batching": {"batch": {"batchSize": 1, "batchInterval": 2000}},
    },
    "sendQuery": True,
    "queryParameters": {"parameters": [{"name": "notify", "value": "false"}]},
    "sendHeaders": True,
    "headerParameters": {
        "parameters": [{"name": "Authorization", "value": "=Bearer {{ $env.MONITOR_HTTP_TOKEN }}"}]
    },
    "authentication": "none",
}

avisar_chat = {
    "method": "POST",
    "url": "={{ $env.GOOGLE_CHAT_WEBHOOK_URL }}",
    "sendBody": True,
    "specifyBody": "json",
    "jsonBody": "={{ JSON.stringify({ text: $json.mensagem }) }}",
    "options": {},
    "authentication": "none",
}

# --- update existing JS ---
sep = node("Separar NFs ausentes")["parameters"]["jsCode"]
if "run.lote" not in sep:
    sep = (
        "const run = $getWorkflowStaticData('run');\n"
        "run.lote = [];\n"
        + sep
    )
    set_js("Separar NFs ausentes", sep)

aus = node("Invoice ausente no relatório ML")["parameters"]["jsCode"]
if "run.lote" not in aus:
    aus = (
        "const run = $getWorkflowStaticData('run');\n"
        "if (!Array.isArray(run.lote)) run.lote = [];\n"
        + aus.replace(
            "return [{\n  json: {",
            "run.lote.push({\n    referencia: origem.referencia,\n    numero: origem.numero,\n    serie: origem.serie,\n    invoiceId: origem.invoiceId || null,\n    encontrado: false,\n    precisaAdmin: true,\n    proximaAcao: 'nenhuma',\n    diagnostico: 'A nota não foi encontrada no relatório do Mercado Livre.',\n    mensagem,\n    assunto: `NF-e ${origem.referencia} — não encontrada no ML`,\n  });\nreturn [{\n  json: {",
        )
    )
    set_js("Invoice ausente no relatório ML", aus)

guardar_js = r"""console.log(`▶ Guardar diagnóstico  ${$json.referencia || ''}  lote=${(($getWorkflowStaticData('run').lote || []).length) + 1}`);
const run = $getWorkflowStaticData('run');
if (!Array.isArray(run.lote)) run.lote = [];
const item = $input.first().json;
run.lote.push(item);
return $input.all();
"""

decidir_js = r"""const run = $getWorkflowStaticData('run');
const lote = Array.isArray(run.lote) ? run.lote : [];
const acoes = lote.map((d) => d.proximaAcao);
let espera = 'nenhuma';
if (acoes.includes('esperar_entrega')) espera = '10min';
else if (acoes.includes('contigencia')) espera = '2min';
console.log(`▶ Espera do lote  notas=${lote.length}  espera=${espera}`);
return [{ json: { espera, total: lote.length, executionId: $execution.id } }];
"""

montar_lote_js = r"""console.log(`▶ Montar relatórios do lote  ${($getWorkflowStaticData('run').lote || []).length}`);
const run = $getWorkflowStaticData('run');
const lote = Array.isArray(run.lote) ? run.lote : [];
const sftp = $input.first().json;
const executionId = $execution.id;
const originais = $('Montar resumo da checagem').first().json.notasAusentes || [];

function xmlNoFtpDe(numero, serie) {
  if (!sftp || !Array.isArray(sftp.notasAusentes)) return null;
  const ainda = sftp.notasAusentes.some(
    (n) => Number(n.numero) === Number(numero) && Number(n.serie) === Number(serie),
  );
  return !ainda;
}

function dumpRastro(itens) {
  return (itens || []).map((item) => {
    const ls = [`${item.n}. ${item.tabela}`];
    if (item.filtro) ls.push(`   WHERE ${item.filtro}`);
    if (!item.executado) ls.push(`   → não executado — ${item.detalhe}`);
    else if (String(item.detalhe || '').startsWith('ERRO:')) ls.push(`   → ${item.detalhe}`);
    else if (!item.linhas && (!item.detalhe || item.detalhe === '0 linhas')) ls.push('   → 0 linhas');
    else ls.push(`   → ${item.linhas} linha(s)${item.detalhe ? ' — ' + item.detalhe : ''}`);
    return ls.join('\n');
  }).join('\n\n');
}

function relatorioDe(diag) {
  const xmlNoFtp = xmlNoFtpDe(diag.numero, diag.serie);
  const referencia = diag.referencia || `${diag.numero}/${diag.serie}`;
  const invoiceId = diag.invoiceId || '';
  const chave = diag.chave || '';
  const diagnostico = diag.diagnostico || diag.mensagem || 'Não foi possível montar o diagnóstico.';
  const proximaAcao = diag.proximaAcao || 'nenhuma';
  const passos = Array.isArray(diag.passos) ? diag.passos : [];
  const contigencia = diag.contigencia;
  const c = passos.find((p) => p.id === 'contigencia');

  let oQueMonitorFez = 'Não reenviou o aviso: o problema não é falta de notificação do Mercado Livre.';
  if (c && c.status === 'ok') {
    if (xmlNoFtp === true) oQueMonitorFez = 'Reenviou o aviso ao sistema (contingência). Depois disso, o XML apareceu no FTP.';
    else if (xmlNoFtp === false) oQueMonitorFez = 'Reenviou o aviso ao sistema (contingência) e conferiu de novo. A nota ainda não chegou ao FTP.';
    else oQueMonitorFez = 'Reenviou o aviso ao sistema (contingência).';
  } else if (c && c.status === 'erro') {
    oQueMonitorFez = `Tentou reenviar o aviso ao sistema (contingência), mas não conseguiu: ${c.detalhe}`;
  } else if (proximaAcao === 'esperar_entrega') {
    oQueMonitorFez = xmlNoFtp === true
      ? 'Aguardou o envio ao FTP. O XML apareceu na pasta.'
      : 'Aguardou o envio ao FTP, mas o arquivo ainda não apareceu na pasta.';
  } else if (proximaAcao === 'rechecar_ftp') {
    oQueMonitorFez = xmlNoFtp === true
      ? 'Conferiu o FTP e encontrou o XML.'
      : 'O envio ao FTP já tinha sido disparado, mas o arquivo ainda não estava na pasta.';
  }

  let banner, oQueFazer, assuntoSufixo, resolvido, precisaAdmin;
  if (xmlNoFtp === true) {
    banner = '✅ Resolvido — o XML da nota já está no FTP.';
    oQueFazer = 'Nada a fazer.';
    assuntoSufixo = 'resolvido';
    resolvido = true;
    precisaAdmin = false;
  } else if (xmlNoFtp === false) {
    banner = '⚠️ Ainda não resolvido — a nota continua ausente no FTP.';
    oQueFazer = 'O monitor ainda vai conferir o lote de novo. Se persistir, acionar o time técnico.';
    assuntoSufixo = 'ainda ausente no FTP';
    resolvido = false;
    precisaAdmin = true;
  } else {
    banner = '⚠️ Precisa de atenção — a nota não chegou ao FTP.';
    oQueFazer = 'Acionar o time técnico.';
    assuntoSufixo = 'precisa de atenção';
    resolvido = false;
    precisaAdmin = true;
  }

  const linhas = [
    `NF ${referencia}`,
    '',
    banner,
    oQueFazer,
    '',
    xmlNoFtp === true ? 'O que tinha acontecido:' : 'O que aconteceu:',
    diagnostico,
    '',
    'O que o monitor fez:',
    oQueMonitorFez,
  ];
  if (xmlNoFtp !== true) {
    const pipeline = passos.filter((p) => p.id !== 'contigencia');
    const primeiroErro = pipeline.findIndex((p) => p.status === 'erro');
    const visiveis = primeiroErro >= 0 ? pipeline.slice(0, primeiroErro + 1) : pipeline;
    if (visiveis.length) {
      linhas.push('', 'Onde a integração parou:');
      for (const p of visiveis) {
        linhas.push(p.detalhe ? `• ${p.titulo} — ${p.detalhe}` : `• ${p.titulo}`);
      }
      if (primeiroErro >= 0 && primeiroErro < pipeline.length - 1) {
        linhas.push('Os passos seguintes ainda não rodaram por causa disso.');
      }
    }
  }
  linhas.push('', 'Rastro técnico');
  linhas.push(`invoice_id=${invoiceId}${chave ? '  chave=' + chave : ''}`);
  if (Array.isArray(diag.rastro) && diag.rastro.length) {
    linhas.push('', dumpRastro(diag.rastro));
  } else if (contigencia && contigencia.notificationId) {
    linhas.push(`contingência ${contigencia.notificationId}`);
  }
  if (xmlNoFtp === true) linhas.push('Rechecar SFTP → XML encontrado');
  else if (xmlNoFtp === false) linhas.push('Rechecar SFTP → XML ainda ausente');
  linhas.push(`execução n8n=${executionId}`);

  return {
    referencia,
    numero: diag.numero,
    serie: diag.serie,
    invoiceId: invoiceId || null,
    executionId,
    proximaAcao,
    diagnostico,
    precisaAdmin,
    resolvido,
    xmlNoFtp,
    assunto: `NF-e ${referencia} — ${assuntoSufixo}`,
    mensagem: linhas.join('\n'),
  };
}

const itens = (lote.length ? lote : originais.map((n) => ({
  numero: n.numero,
  serie: n.serie,
  referencia: `${n.numero}/${n.serie}`,
  proximaAcao: 'nenhuma',
  diagnostico: 'Diagnóstico não gravado neste ciclo.',
}))).map(relatorioDe);

run.faltandoAposLote = itens.filter((i) => i.xmlNoFtp === false).map((i) => ({
  numero: i.numero,
  serie: i.serie,
  referencia: i.referencia,
}));

return itens.map((json) => ({ json }));
"""

conferir_js = r"""const run = $getWorkflowStaticData('run');
const originais = $('Montar resumo da checagem').first().json.notasAusentes || [];
const sftp = $input.first().json;
const ausentes = Array.isArray(sftp.notasAusentes) ? sftp.notasAusentes : [];
const faltando = originais.filter((o) =>
  ausentes.some((a) => Number(a.numero) === Number(o.numero) && Number(a.serie) === Number(o.serie)),
);
const noFtp = originais.length - faltando.length;
console.log(`▶ Conferir lote no FTP  ${noFtp}/${originais.length}  faltando=${faltando.length}`);
return [{
  json: {
    aindaFaltam: faltando.length > 0,
    faltando,
    total: originais.length,
    noFtp,
    executionId: $execution.id,
  },
}];
"""

relatorio_conf_js = r"""const sftp = $input.first().json;
const originais = $('Montar resumo da checagem').first().json.notasAusentes || [];
const ausentes = Array.isArray(sftp.notasAusentes) ? sftp.notasAusentes : [];
const faltando = originais.filter((o) =>
  ausentes.some((a) => Number(a.numero) === Number(o.numero) && Number(a.serie) === Number(o.serie)),
);
const noFtp = originais.length - faltando.length;
const executionId = $execution.id;
const listaFalta = faltando.map((n) => `${n.numero}/${n.serie}`).join(', ');
const listaOk = originais
  .filter((o) => !faltando.some((f) => f.numero === o.numero && f.serie === o.serie))
  .map((n) => `${n.numero}/${n.serie}`)
  .join(', ');

let mensagem;
let assunto;
if (originais.length === 0) {
  assunto = 'Lote de furos — nada a conferir';
  mensagem = 'Não havia furos para conferir no FTP.';
} else if (faltando.length === 0) {
  assunto = `Lote de furos — ${noFtp}/${originais.length} no FTP`;
  mensagem =
    `✅ Lote concluído — as ${originais.length} notas ausentes já estão no FTP.\n\n` +
    `Notas: ${listaOk}\n\n` +
    `execução n8n=${executionId}`;
} else {
  assunto = `Lote de furos — ${noFtp}/${originais.length} no FTP`;
  mensagem =
    `⚠️ Lote incompleto — ${noFtp} de ${originais.length} notas estão no FTP.\n\n` +
    (listaOk ? `Já no FTP: ${listaOk}\n` : '') +
    `Ainda faltam: ${listaFalta}\n\n` +
    'Acionar o time técnico para as que continuam ausentes.\n\n' +
    `execução n8n=${executionId}`;
}

return [{
  json: {
    aindaFaltam: faltando.length > 0,
    faltando,
    total: originais.length,
    noFtp,
    executionId,
    precisaAdmin: faltando.length > 0,
    assunto,
    mensagem,
  },
}];
"""

new_nodes = [
    {
        "parameters": {"batchSize": 1, "options": {}},
        "id": "a1b2c3d4-0001-4000-8000-000000000050",
        "name": "Uma NF por vez",
        "type": "n8n-nodes-base.splitInBatches",
        "typeVersion": 3,
        "position": [1880, 500],
    },
    {
        "parameters": {"jsCode": guardar_js},
        "id": "a1b2c3d4-0001-4000-8000-000000000051",
        "name": "Guardar diagnóstico",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [2920, 360],
    },
    {
        "parameters": {"jsCode": decidir_js},
        "id": "a1b2c3d4-0001-4000-8000-000000000052",
        "name": "Decidir espera do lote",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [2140, 200],
    },
    {
        "parameters": {
            "rules": {
                "values": [
                    {
                        "conditions": {
                            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                            "conditions": [{
                                "id": "sw-10",
                                "leftValue": "={{ $json.espera }}",
                                "rightValue": "10min",
                                "operator": {"type": "string", "operation": "equals"},
                            }],
                            "combinator": "and",
                        },
                        "renameOutput": True,
                        "outputKey": "10 min",
                    },
                    {
                        "conditions": {
                            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                            "conditions": [{
                                "id": "sw-2",
                                "leftValue": "={{ $json.espera }}",
                                "rightValue": "2min",
                                "operator": {"type": "string", "operation": "equals"},
                            }],
                            "combinator": "and",
                        },
                        "renameOutput": True,
                        "outputKey": "2 min",
                    },
                ]
            },
            "options": {"fallbackOutput": "extra"},
        },
        "id": "a1b2c3d4-0001-4000-8000-000000000053",
        "name": "Espera do lote?",
        "type": "n8n-nodes-base.switch",
        "typeVersion": 3.2,
        "position": [2400, 200],
    },
    {
        "parameters": {"jsCode": montar_lote_js},
        "id": "a1b2c3d4-0001-4000-8000-000000000054",
        "name": "Montar relatórios do lote",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [3960, 200],
    },
    {
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                "conditions": [{
                    "id": "cond-faltam",
                    "leftValue": "={{ $json.aindaFaltam }}",
                    "rightValue": "",
                    "operator": {"type": "boolean", "operation": "true", "singleValue": True},
                }],
                "combinator": "and",
            },
            "options": {},
        },
        "id": "a1b2c3d4-0001-4000-8000-000000000055",
        "name": "Ainda faltam no FTP?",
        "type": "n8n-nodes-base.if",
        "typeVersion": 2.2,
        "position": [2660, 40],
    },
    {
        "parameters": {"jsCode": conferir_js},
        "id": "a1b2c3d4-0001-4000-8000-000000000062",
        "name": "Conferir pendências do lote",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [2400, 40],
    },
    {
        "parameters": {"resume": "timeInterval", "amount": 120, "unit": "seconds"},
        "id": "a1b2c3d4-0001-4000-8000-000000000056",
        "name": "Esperar 2 min (conferência)",
        "type": "n8n-nodes-base.wait",
        "typeVersion": 1.1,
        "position": [2920, -80],
    },
    {
        "parameters": deepcopy(http_recheck),
        "id": "a1b2c3d4-0001-4000-8000-000000000057",
        "name": "Rechecar FTP (conferência)",
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": [3180, -80],
        "onError": "continueRegularOutput",
        "retryOnFail": True,
        "maxTries": 5,
        "waitBetweenTries": 5000,
    },
    {
        "parameters": {"jsCode": relatorio_conf_js},
        "id": "a1b2c3d4-0001-4000-8000-000000000058",
        "name": "Relatório de conferência do lote",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [3440, 40],
    },
    {
        "parameters": deepcopy(avisar_chat),
        "id": "a1b2c3d4-0001-4000-8000-000000000059",
        "name": "Avisar Google Chat (lote)",
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": [3700, -80],
        "onError": "continueRegularOutput",
    },
    {
        "parameters": {
            "fromEmail": "={{ $env.ALERT_EMAIL_FROM }}",
            "toEmail": "={{ $env.ALERT_EMAIL_TO }}",
            "subject": "={{ $json.assunto }}",
            "emailFormat": "text",
            "text": "={{ $json.mensagem }}",
            "options": {},
        },
        "id": "a1b2c3d4-0001-4000-8000-000000000060",
        "name": "Avisar e-mail (lote)",
        "type": "n8n-nodes-base.emailSend",
        "typeVersion": 2.1,
        "position": [3700, 40],
        "onError": "continueRegularOutput",
    },
    {
        "parameters": {
            "method": "POST",
            "url": "={{ $env.WHATSAPP_WEBHOOK_URL }}",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify({ number: $env.WHATSAPP_TO, text: $json.mensagem }) }}",
            "options": {},
            "authentication": "none",
        },
        "id": "a1b2c3d4-0001-4000-8000-000000000061",
        "name": "Avisar WhatsApp (lote)",
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": [3700, 160],
        "onError": "continueRegularOutput",
    },
    {
        "parameters": {
            "content": "## Lote de furos\nUma NF por vez (Wait do n8n só segura 1 item).\nDiagnostica todas → espera 2 ou 10 min uma vez → confere o FTP do lote. Se ainda faltar, espera +2 min e confere de novo.",
            "height": 180,
            "width": 380,
            "color": 5,
        },
        "id": "a1b2c3d4-0001-4000-8000-000000000063",
        "name": "Etapa lote",
        "type": "n8n-nodes-base.stickyNote",
        "typeVersion": 1,
        "position": [1880, -80],
    },
]

existing_ids = {n["id"] for n in wf["nodes"]}
for n in new_nodes:
    if n["id"] not in existing_ids:
        wf["nodes"].append(n)

# Rechecar FTP already has Authorization in headerParameters - conferência copy is fine.

c = wf["connections"]

# Há NF true → loop node (was Localizar)
c["Há NF para cruzar?"]["main"][0] = [{"node": "Uma NF por vez", "type": "main", "index": 0}]

# SplitInBatches: [0]=done, [1]=loop
c["Uma NF por vez"] = {
    "main": [
        [{"node": "Decidir espera do lote", "type": "main", "index": 0}],
        [{"node": "Localizar invoice no ZIP do ML", "type": "main", "index": 0}],
    ]
}

# Diagnosticar → Guardar → loop (was Próxima ação)
c["Diagnosticar no Nerus"]["main"][0] = [{"node": "Guardar diagnóstico", "type": "main", "index": 0}]
c["Guardar diagnóstico"] = {"main": [[{"node": "Uma NF por vez", "type": "main", "index": 0}]]}

# Invoice ausente → loop (was Montar relatório)
c["Invoice ausente no relatório ML"]["main"][0] = [{"node": "Uma NF por vez", "type": "main", "index": 0}]

c["Decidir espera do lote"] = {"main": [[{"node": "Espera do lote?", "type": "main", "index": 0}]]}

# Switch: 10min, 2min, fallback extra
c["Espera do lote?"] = {
    "main": [
        [{"node": "Esperar 10 min o envio FTP", "type": "main", "index": 0}],
        [{"node": "Esperar 2 min após contingência", "type": "main", "index": 0}],
        [{"node": "Rechecar FTP", "type": "main", "index": 0}],
    ]
}

# Waits skip entrega, go to Rechecar FTP
c["Esperar 2 min após contingência"]["main"][0] = [{"node": "Rechecar FTP", "type": "main", "index": 0}]
c["Esperar 10 min o envio FTP"]["main"][0] = [{"node": "Rechecar FTP", "type": "main", "index": 0}]

# Rechecar FTP → montar lote + conferir (parallel)
c["Rechecar FTP"]["main"][0] = [
    {"node": "Montar relatórios do lote", "type": "main", "index": 0},
    {"node": "Conferir pendências do lote", "type": "main", "index": 0},
]

c["Montar relatórios do lote"] = {
    "main": [[
        {"node": "Avisar Google Chat (furo)", "type": "main", "index": 0},
        {"node": "Avisar e-mail (furo)", "type": "main", "index": 0},
        {"node": "Avisar WhatsApp (furo)", "type": "main", "index": 0},
    ]]
}

c["Conferir pendências do lote"] = {"main": [[{"node": "Ainda faltam no FTP?", "type": "main", "index": 0}]]}

c["Ainda faltam no FTP?"] = {
    "main": [
        [{"node": "Esperar 2 min (conferência)", "type": "main", "index": 0}],
        [{"node": "Relatório de conferência do lote", "type": "main", "index": 0}],
    ]
}

c["Esperar 2 min (conferência)"] = {"main": [[{"node": "Rechecar FTP (conferência)", "type": "main", "index": 0}]]}
c["Rechecar FTP (conferência)"] = {"main": [[{"node": "Relatório de conferência do lote", "type": "main", "index": 0}]]}

c["Relatório de conferência do lote"] = {
    "main": [[
        {"node": "Avisar Google Chat (lote)", "type": "main", "index": 0},
        {"node": "Avisar e-mail (lote)", "type": "main", "index": 0},
        {"node": "Avisar WhatsApp (lote)", "type": "main", "index": 0},
    ]]
}

# Sticky etapa 3
try:
    node("Etapa 3 — cruzar no ML")["parameters"]["content"] = (
        "## Etapa 3 — cruzar furo no ML\n"
        "Uma NF por vez: localiza invoice → diagnostica.\n"
        "Depois do lote: espera 2/10 min uma vez e confere o FTP de todas."
    )
except StopIteration:
    pass

p.write_text(json.dumps(wf, indent=2, ensure_ascii=False) + "\n")
print("nodes", len(wf["nodes"]))
print("Uma NF por vez outs", wf["connections"]["Uma NF por vez"])
print("Diagnosticar →", wf["connections"]["Diagnosticar no Nerus"])
print("Há NF true →", wf["connections"]["Há NF para cruzar?"]["main"][0])
