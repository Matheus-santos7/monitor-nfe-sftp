import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("./workflows/monitor-sftp.json", import.meta.url);
const wf = JSON.parse(readFileSync(path, "utf8"));

const jsMontarRelatorio = `console.log(\`▶ Montar relatório do furo  \${$json.referencia || ''}  \${$json.proximaAcao || ''}\`);
function jsonDe(nomeNo) {
  try {
    return $(nomeNo).item.json;
  } catch (e) {
    return null;
  }
}

const entrada = $input.first().json;
const executionId = entrada.executionId || $execution.id;
const diag = jsonDe('Diagnosticar no Nerus');
const sftp = jsonDe('Rechecar FTP');
const entrega = jsonDe('Rechecar entrega no Nerus');
const origem = jsonDe('Normalizar invoice') || entrada;

if (!diag && entrada.mensagem) {
  const jaTemExec = String(entrada.mensagem).includes('execução n8n=');
  return [{
    json: {
      ...entrada,
      executionId,
      mensagem: jaTemExec ? entrada.mensagem : \`\${entrada.mensagem}\\n\\nexecução n8n=\${executionId}\`,
    },
  }];
}

let xmlNoFtp = null;
if (sftp && Array.isArray(sftp.notasAusentes)) {
  const aindaFuro = sftp.notasAusentes.some(
    (n) => Number(n.numero) === Number(origem.numero) && Number(n.serie) === Number(origem.serie),
  );
  xmlNoFtp = !aindaFuro;
}

const classificacaoEntrega = (entrega && entrega.classificacaoEntrega) || null;
const referencia = origem.referencia || (diag && diag.referencia) || '';
const invoiceId = origem.invoiceId || (diag && diag.invoiceId) || '';
const chave = (diag && diag.chave) || origem.chave || '';
const diagnostico = (diag && diag.diagnostico) || '';
const proximaAcao = (diag && diag.proximaAcao) || origem.proximaAcao || 'nenhuma';
const passos = diag && Array.isArray(diag.passos) ? diag.passos : [];
const contigencia = diag && diag.contigencia;

function oQueMonitorFez() {
  const c = passos.find((p) => p.id === 'contigencia');
  if (c && c.status === 'ok') {
    if (xmlNoFtp === true) return 'Reenviou o aviso ao sistema (contingência). Depois disso, o XML apareceu no FTP.';
    if (xmlNoFtp === false) return 'Reenviou o aviso ao sistema (contingência) e conferiu de novo. A nota ainda não chegou ao FTP.';
    return 'Reenviou o aviso ao sistema (contingência).';
  }
  if (c && c.status === 'erro') {
    return \`Tentou reenviar o aviso ao sistema (contingência), mas não conseguiu: \${c.detalhe}\`;
  }
  if (proximaAcao === 'esperar_entrega') {
    if (xmlNoFtp === true) return 'Aguardou o envio ao FTP. O XML apareceu na pasta.';
    if (xmlNoFtp === false) return 'Aguardou o envio ao FTP, mas o arquivo ainda não apareceu na pasta.';
    return 'A nota já estava no Nerus; o envio ao FTP ainda estava em andamento.';
  }
  if (proximaAcao === 'rechecar_ftp') {
    if (xmlNoFtp === true) return 'Conferiu o FTP e encontrou o XML.';
    if (xmlNoFtp === false) return 'O envio ao FTP já tinha sido disparado, mas o arquivo ainda não estava na pasta.';
    return 'O envio ao FTP já tinha sido disparado. Falta conferir se o XML chegou na pasta.';
  }
  return 'Não reenviou o aviso: o problema não é falta de notificação do Mercado Livre.';
}

let banner;
let oQueFazer;
let assuntoSufixo;
let resolvido;
let precisaAdmin;
if (xmlNoFtp === true) {
  banner = '✅ Resolvido — o XML da nota já está no FTP.';
  oQueFazer = 'Nada a fazer.';
  assuntoSufixo = 'resolvido';
  resolvido = true;
  precisaAdmin = false;
} else if (xmlNoFtp === false && classificacaoEntrega === 'enviada') {
  banner = '⏳ Em andamento — o envio ao FTP já foi disparado, mas o arquivo ainda não apareceu na pasta.';
  oQueFazer = 'Aguardar o próximo ciclo de monitoramento. Se a nota não aparecer, acionar o time técnico.';
  assuntoSufixo = 'envio em andamento';
  resolvido = false;
  precisaAdmin = true;
} else if (xmlNoFtp === false) {
  banner = '⚠️ Ainda não resolvido — a nota continua ausente no FTP.';
  oQueFazer = 'Acionar o time técnico.';
  assuntoSufixo = 'ainda ausente no FTP';
  resolvido = false;
  precisaAdmin = true;
} else if (proximaAcao === 'contigencia') {
  banner = '⚠️ Pendência — o Mercado Livre não avisou o sistema.';
  oQueFazer = 'O monitor já reenviou o aviso. Aguardar 1–3 minutos e conferir se o XML chegou ao FTP.';
  assuntoSufixo = 'Mercado Livre não avisou';
  resolvido = false;
  precisaAdmin = true;
} else if (proximaAcao === 'esperar_entrega') {
  banner = '⏳ Em andamento — a nota está no Nerus, aguardando o envio ao FTP.';
  oQueFazer = 'Aguardar cerca de 10 minutos e conferir de novo.';
  assuntoSufixo = 'aguardando envio ao FTP';
  resolvido = false;
  precisaAdmin = true;
} else if (proximaAcao === 'rechecar_ftp') {
  banner = '⏳ Em andamento — conferindo se o XML já está no FTP.';
  oQueFazer = 'Conferir o FTP. Se o XML não estiver lá, acionar o time técnico.';
  assuntoSufixo = 'conferir FTP';
  resolvido = false;
  precisaAdmin = false;
} else {
  banner = '⚠️ Precisa de atenção — a nota não chegou ao FTP.';
  oQueFazer = 'Acionar o time técnico. Este caso não se resolve sozinho.';
  assuntoSufixo = 'precisa de atenção';
  resolvido = false;
  precisaAdmin = true;
}

if (sftp && (sftp.error || sftp.ok === false)) {
  oQueFazer = \`Não deu para conferir o FTP (\${sftp.erro || (sftp.error && sftp.error.message) || 'HTTP'}). \${oQueFazer}\`;
}

const linhas = [
  \`NF \${referencia}\`,
  '',
  banner,
  oQueFazer,
  '',
  xmlNoFtp === true ? 'O que tinha acontecido:' : 'O que aconteceu:',
  diagnostico || 'Não foi possível montar o diagnóstico.',
  '',
  'O que o monitor fez:',
  oQueMonitorFez(),
];

if (xmlNoFtp !== true) {
  const pipeline = passos.filter((p) => p.id !== 'contigencia');
  if (pipeline.length) {
    linhas.push('', 'Onde a integração parou:');
    for (const p of pipeline) {
      linhas.push(p.detalhe ? \`• \${p.titulo} — \${p.detalhe}\` : \`• \${p.titulo}\`);
    }
  }
}

linhas.push('', 'Dados técnicos:');
if (invoiceId) linhas.push(\`invoice \${invoiceId}\`);
if (chave) linhas.push(\`chave \${chave}\`);
if (contigencia && contigencia.notificationId) linhas.push(\`contingência \${contigencia.notificationId}\`);
linhas.push(\`execução n8n=\${executionId}\`);

const mensagem = linhas.join('\\n');

return [{
  json: {
    referencia,
    numero: origem.numero,
    serie: origem.serie,
    invoiceId: invoiceId || null,
    encontrado: Boolean(origem.encontrado),
    motivo: origem.motivo,
    identificador: origem.identificador,
    executionId,
    proximaAcao,
    diagnostico,
    precisaAdmin,
    resolvido,
    assunto: \`NF-e \${referencia} — \${assuntoSufixo}\`,
    mensagem,
  },
}];
`;

const jsSerieSemXml = `console.log(\`▶ Série sem XML para cruzar  \${$json.identificador || ''}\`);
const origem = $input.first().json;
const executionId = origem.executionId || $execution.id;
const quem = origem.referencia || origem.identificador || '';
const mensagem =
  (quem ? \`NF \${quem}\\n\\n\` : '') +
  '⚠️ Precisa de atenção — não foi possível cruzar esta série com o Mercado Livre.\\n' +
  'Não há XML no FTP para montar a sequência das notas.\\n\\n' +
  'O que fazer:\\n' +
  'Acionar o time técnico.\\n\\n' +
  \`execução n8n=\${executionId}\`;

return [{
  json: {
    encontrado: false,
    precisaAdmin: true,
    proximaAcao: 'nenhuma',
    motivo: origem.motivo || 'serie_sem_xml_ou_sem_furo_listavel',
    identificador: origem.identificador,
    mlUserId: origem.mlUserId,
    executionId,
    assunto: \`NF-e \${origem.identificador || ''} — série sem XML para cruzar\`,
    mensagem,
  },
}];
`;

const jsInvoiceAusente = `console.log(\`▶ Invoice ausente no relatório ML  \${$json.referencia || ''}\`);
const origem = $input.first().json;
const executionId = origem.executionId || $execution.id;
const mensagem =
  \`NF \${origem.referencia || ''}\\n\\n\` +
  '⚠️ Precisa de atenção — a nota não foi encontrada no relatório do Mercado Livre.\\n\\n' +
  'Sem o identificador da nota no Mercado Livre, o diagnóstico no Nerus não consegue rodar.\\n\\n' +
  'O que fazer:\\n' +
  'Acionar o time técnico.\\n\\n' +
  \`execução n8n=\${executionId}\`;

return [{
  json: {
    referencia: origem.referencia,
    numero: origem.numero,
    serie: origem.serie,
    invoiceId: origem.invoiceId || null,
    encontrado: false,
    motivo: origem.motivo,
    identificador: origem.identificador,
    executionId,
    precisaAdmin: true,
    proximaAcao: 'nenhuma',
    assunto: \`NF-e \${origem.referencia} — não encontrada no ML\`,
    mensagem,
  },
}];
`;

const patches = {
  "Montar relatório do furo": jsMontarRelatorio,
  "Série sem XML para cruzar": jsSerieSemXml,
  "Invoice ausente no relatório ML": jsInvoiceAusente,
};

for (const node of wf.nodes) {
  if (patches[node.name]) {
    node.parameters.jsCode = patches[node.name];
  }
}

writeFileSync(path, JSON.stringify(wf, null, 2) + "\n");
console.log("patched", Object.keys(patches).join(", "));
