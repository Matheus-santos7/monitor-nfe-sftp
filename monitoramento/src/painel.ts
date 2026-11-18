// Página do painel. Lê GET /status (o monitor checa SFTP + teto ML a cada PAINEL_INTERVALO_MIN).
export const PAINEL_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Painel NF-e SFTP</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --tx:#1b1f24; --mut:#5f6b7a; --bd:#dde2e8;
          --ok:#1a7f37; --al:#c2410c; --er:#b42318; --okbg:#e7f5ec; --albg:#fff1e6; --erbg:#fdecea; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1216; --card:#171b21; --tx:#e6e9ed; --mut:#98a2b0; --bd:#2a313a;
            --ok:#4ac26b; --al:#fb923c; --er:#f87171; --okbg:#12261a; --albg:#2a1a0e; --erbg:#2a1414; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--tx); font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:960px; margin:0 auto; padding:20px 16px 40px; }
  header { display:flex; flex-wrap:wrap; gap:8px 16px; align-items:baseline; justify-content:space-between; }
  h1 { font-size:20px; margin:0; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:var(--mut); margin:24px 0 8px; }
  .mut { color:var(--mut); font-size:13px; }
  .banner { margin-top:16px; padding:16px; border-radius:10px; border:1px solid var(--bd); font-size:17px; font-weight:600; }
  .ok { background:var(--okbg); color:var(--ok); } .alerta { background:var(--albg); color:var(--al); }
  .erro { background:var(--erbg); color:var(--er); } .aguardando { background:var(--card); color:var(--mut); }
  .card { background:var(--card); border:1px solid var(--bd); border-radius:10px; overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--bd); white-space:nowrap; }
  th { font-size:12px; color:var(--mut); font-weight:600; }
  tr:last-child td { border-bottom:0; }
  ul { margin:0; padding:12px 12px 12px 30px; }
  .vazio { padding:12px; color:var(--mut); }
  .velho { color:var(--er); font-weight:600; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:1px; background:var(--bd); }
  .kpi { background:var(--card); padding:12px; } .kpi b { display:block; font-size:22px; font-variant-numeric:tabular-nums; }
  .kpi span { font-size:12px; color:var(--mut); }
  .saudavel { color:var(--ok); } .atencao { color:var(--al); } .critico { color:var(--er); }
  select { font:inherit; padding:5px 8px; border-radius:8px; border:1px solid var(--bd); background:var(--card); color:var(--tx); }
  .linhah2 { display:flex; justify-content:space-between; align-items:center; gap:8px; }
  button { font:inherit; padding:6px 12px; border-radius:8px; border:1px solid var(--bd); background:var(--card); color:var(--tx); cursor:pointer; }
</style>
</head>
<body>
<main>
  <header>
    <h1 id="cliente">Painel NF-e SFTP</h1>
    <span class="mut"><span id="checado">—</span> · <button id="recarregar" type="button">Atualizar</button></span>
  </header>
  <div id="banner" class="banner aguardando" role="status" aria-live="polite">Carregando…</div>

  <h2>Avisos</h2>
  <div class="card"><ul id="avisos"></ul></div>

  <h2>Notas ausentes no FTP</h2>
  <div class="card"><table><thead><tr><th>NF / série</th><th>Ausente desde</th><th>Há</th></tr></thead><tbody id="ausentes"></tbody></table></div>

  <div class="linhah2"><h2>Saúde do dia</h2><label class="mut">Dia <select id="dia"></select></label></div>
  <div class="card"><div class="kpis" id="kpis"></div></div>

  <h2>Histórico de avisos do dia</h2>
  <div class="card"><table><thead><tr><th>Hora</th><th>Evento</th><th>Detalhe</th></tr></thead><tbody id="eventos"></tbody></table></div>

  <h2>Séries</h2>
  <div class="card"><table><thead><tr><th>Série</th><th>XMLs no FTP</th><th>FTP</th><th>Teto ML</th><th>Última ML no FTP</th><th>Ausentes</th></tr></thead><tbody id="series"></tbody></table></div>
</main>
<script>
  const token = new URLSearchParams(location.search).get("token") || "";
  const auth = { cache: "no-store", headers: { Authorization: "Bearer " + token } };
  const VELHO_MIN = 15; // furo com mais de 15 min já é atraso real, não latência de envio
  const $ = (id) => document.getElementById(id);
  const hora = (iso) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const minDesde = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  const idade = (m) => m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min";
  function linha(cels, cls) {
    const tr = document.createElement("tr");
    for (const c of cels) { const td = document.createElement("td"); td.textContent = c; tr.append(td); }
    if (cls) tr.className = cls;
    return tr;
  }
  function item(txt) { const li = document.createElement("li"); li.textContent = txt; return li; }

  let ultimo = null;
  function render(s) {
    ultimo = s;
    $("cliente").textContent = s.cliente ? s.cliente.nome + " · Conta " + s.cliente.conta : "Painel NF-e SFTP";
    document.title = (s.status === "ok" ? "✅" : s.status === "aguardando" ? "⏳" : "⚠️") + " Painel NF-e SFTP";
    const r = s.resultado;
    const faltam = r ? r.notasAusentes.length : 0;
    const msg = {
      ok: "Tudo integrado — última NF do ML está no FTP e não há furos",
      alerta: faltam + " nota(s) ausente(s) no FTP",
      erro: s.erro ? "Checagem falhou: " + s.erro : "Checagem incompleta — veja os avisos",
      aguardando: "Aguardando a primeira checagem…",
    }[s.status];
    $("banner").className = "banner " + s.status;
    $("banner").textContent = msg;

    const atraso = s.checadoEm ? minDesde(s.checadoEm) : null;
    $("checado").textContent = s.checadoEm
      ? "checado " + hora(s.checadoEm) + " (há " + idade(atraso) + ") · a cada " + s.intervaloMin + " min" + (s.ocupado ? " · checando agora…" : "")
      : "sem checagem ainda";

    const avisos = [...(s.avisos || [])];
    if (s.erro && r) avisos.unshift("Última checagem falhou (" + s.erro + "); dados abaixo são de antes.");
    if (atraso != null && s.intervaloMin && atraso > s.intervaloMin * 3) avisos.unshift("Monitor sem checar há " + idade(atraso) + " — verifique o container.");
    $("avisos").replaceChildren(...(avisos.length ? avisos.map(item) : [item("Nenhum aviso")]));

    const aus = r ? r.notasAusentes.map((n) => {
      const desde = s.ausentesDesde[n.numero + "/" + n.serie];
      const m = desde ? minDesde(desde) : 0;
      return linha([n.numero + " / " + n.serie, desde ? hora(desde) : "—", desde ? idade(m) : "—"], m >= VELHO_MIN ? "velho" : "");
    }) : [];
    $("ausentes").replaceChildren(...(aus.length ? aus : [linha(["Nenhuma", "", ""])]));

    $("series").replaceChildren(...(r ? r.series.map((x) => linha([
      String(x.serie),
      x.totalAusentes === -1 ? "0" : String(x.total),
      x.totalAusentes === -1 ? "—" : x.min + " → " + x.max,
      x.tetoMl != null ? String(x.tetoMl) : "—",
      x.ultimaMlNoFtp == null ? "—" : x.ultimaMlNoFtp ? "sim" : "NÃO",
      x.totalAusentes === -1 ? "sem XML" : String(x.totalAusentes),
    ], x.totalAusentes !== 0 ? "velho" : "")) : []));
  }

  const ROTULO = { furo_aberto: "⚠️ Furo", furo_resolvido: "✅ Resolvido", checagem_falhou: "❌ Falha", checagem_voltou: "🔄 Voltou", aviso: "ℹ️ Aviso" };
  const NIVEL = { saudavel: "Saudável", atencao: "Atenção", critico: "Crítico", sem_dados: "Sem dados" };
  const fmtDia = (d) => d.slice(6, 8) + "/" + d.slice(4, 6) + "/" + d.slice(0, 4);
  const min = (v) => v == null ? "—" : idade(v);
  function kpi(valor, rotulo, cls) {
    const el = document.createElement("div"); el.className = "kpi";
    const b = document.createElement("b"); b.textContent = valor; if (cls) b.className = cls;
    const sp = document.createElement("span"); sp.textContent = rotulo;
    el.append(b, sp); return el;
  }
  let diaEscolhido = "";
  async function carregarHistorico() {
    try {
      const resp = await fetch("/historico" + (diaEscolhido ? "?dia=" + diaEscolhido : ""), auth);
      const h = await resp.json();
      if (!resp.ok) throw new Error(h.erro || "HTTP " + resp.status);
      const dias = h.dias.includes(h.dia) ? h.dias : [h.dia, ...h.dias];
      $("dia").replaceChildren(...dias.map((d) => { const o = new Option(fmtDia(d), d); o.selected = d === h.dia; return o; }));
      const r = h.resumo;
      $("kpis").replaceChildren(...(r ? [
        kpi(NIVEL[r.nivel], "Saúde", r.nivel),
        kpi(r.saudePct == null ? "—" : r.saudePct + "%", "Checagens OK (" + h.checagens.ok + "/" + h.checagens.total + ")"),
        kpi(String(r.furosAbertos), "Furos no dia"),
        kpi(String(r.furosResolvidos), "Resolvidos"),
        kpi(String(r.abertosAgora), "Em aberto" + (r.maisAntigoMin != null ? " (mais antigo " + idade(r.maisAntigoMin) + ")" : ""), r.abertosAgora ? "critico" : ""),
        kpi(min(r.resolucaoMediaMin), "Tempo médio p/ chegar ao FTP"),
        kpi(min(r.resolucaoMaxMin), "Pior tempo p/ chegar ao FTP"),
        kpi(String(r.falhasChecagem), "Falhas de checagem", r.falhasChecagem ? "atencao" : ""),
      ] : [kpi("—", "Sem checagens neste dia")]));
      const evs = (h.eventos || []).slice().reverse().map((e) => linha([
        new Date(e.em).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }),
        ROTULO[e.tipo] || e.tipo, e.texto,
      ]));
      $("eventos").replaceChildren(...(evs.length ? evs : [linha(["", "Nenhum aviso neste dia", ""])]));
    } catch (e) {
      $("eventos").replaceChildren(linha(["", "Histórico indisponível", e.message]));
    }
  }
  $("dia").onchange = (ev) => { diaEscolhido = ev.target.value; carregarHistorico(); };

  async function carregar() {
    carregarHistorico();
    try {
      const resp = await fetch("/status", auth);
      const s = await resp.json();
      if (!resp.ok) throw new Error(s.erro || "HTTP " + resp.status);
      render(s);
    } catch (e) {
      $("banner").className = "banner erro";
      $("banner").textContent = "Painel sem conexão com o monitor: " + e.message;
    }
  }
  $("recarregar").onclick = carregar;
  carregar();
  setInterval(carregar, 60000); // lê o estado a cada 1 min; o monitor checa a cada intervaloMin
  setInterval(() => ultimo && render(ultimo), 30000); // mantém o "há X min" vivo
</script>
</body>
</html>`;
