(function() {
  "use strict";
  var RANGOS = [
    { d: 7, label: "7 d" },
    { d: 30, label: "30 d" },
    { d: 90, label: "90 d" },
    { d: 0, label: "Todo" }
  ];
  var dias = 30;
  var datos = null;
  var cargando = false;
  var CSS = [
    "#st-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:none;align-items:center;justify-content:center;padding:12px}",
    '#st-overlay[data-open="1"]{display:flex}',
    "#st-box{width:min(1080px,96vw);max-height:92vh;overflow:auto;background:var(--bg-2,#1b1b1b);color:var(--text-1,#eee);border:1px solid var(--line,#3a3a3a);border-radius:12px;padding:16px 18px;font:14px/1.45 system-ui,sans-serif}",
    "#st-box h3{margin:0;font-size:17px;display:flex;align-items:center;gap:8px}",
    ".st-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;position:sticky;top:-16px;z-index:3;background:var(--bg-2,#1b1b1b);padding:8px 0 6px}",
    ".st-sub{font-size:12px;opacity:.6;margin-bottom:12px}",
    ".st-x{background:transparent;color:inherit;border:1px solid var(--line,#3a3a3a);border-radius:8px;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:15px;line-height:1;flex:0 0 auto;margin-left:4px;order:9}",
    ".st-x:hover{border-color:var(--text-3,#888)}",
    ".st-seg{display:flex;gap:4px;margin-left:auto}",
    ".st-seg button{background:transparent;color:inherit;border:1px solid var(--line,#3a3a3a);border-radius:7px;padding:4px 9px;cursor:pointer;font-size:12px}",
    '.st-seg button[data-on="1"]{border-color:var(--accent,#4fd8e5);color:var(--accent,#4fd8e5)}',
    ".st-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:8px;margin:4px 0 14px}",
    ".st-kpi{border:1px solid var(--line,#3a3a3a);border-radius:9px;padding:9px 11px}",
    ".st-kpi .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;opacity:.6}",
    ".st-kpi .v{font-size:19px;font-weight:650;margin-top:2px}",
    ".st-kpi .s{font-size:11px;opacity:.55}",
    ".st-sec{margin:16px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;opacity:.65;display:flex;gap:8px;align-items:baseline}",
    ".st-bars{display:flex;align-items:flex-end;gap:2px;height:96px;padding:6px 0;border-bottom:1px solid var(--line,#3a3a3a)}",
    ".st-bars .b{flex:1;min-width:2px;background:var(--accent,#4fd8e5);opacity:.75;border-radius:2px 2px 0 0;min-height:1px}",
    ".st-bars .b:hover{opacity:1}",
    ".st-axis{display:flex;justify-content:space-between;font-size:10.5px;opacity:.5;margin-top:3px}",
    ".st-hbars{display:flex;align-items:flex-end;gap:1px;height:44px}",
    ".st-hbars .b{flex:1;background:var(--text-3,#888);opacity:.55;border-radius:1px;min-height:1px}",
    "table.st-t{width:100%;border-collapse:collapse;font-size:12.5px}",
    "table.st-t th{text-align:right;font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;opacity:.55;padding:5px 7px;border-bottom:1px solid var(--line,#3a3a3a);white-space:nowrap}",
    "table.st-t th:first-child,table.st-t td:first-child{text-align:left}",
    "table.st-t td{padding:5px 7px;border-bottom:1px solid var(--line,#2a2a2a);text-align:right;white-space:nowrap}",
    "table.st-t tr:hover td{background:rgba(255,255,255,.03)}",
    ".st-model{display:flex;flex-direction:column;gap:2px;align-items:flex-start}",
    ".st-model b{font-weight:600}",
    ".st-mini{height:3px;border-radius:2px;background:var(--accent,#4fd8e5);opacity:.6}",
    ".st-warn{font-size:11.5px;color:var(--warn,#e5a341);margin-top:6px}",
    ".st-foot{display:flex;flex-wrap:wrap;gap:14px;font-size:11.5px;opacity:.65;margin-top:14px;border-top:1px solid var(--line,#3a3a3a);padding-top:10px}",
    ".st-err{color:var(--danger,#e5484d);font-size:12.5px;white-space:pre-wrap}",
    "@media(max-width:820px){.st-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}table.st-t{font-size:12px}}",
    "@media(max-width:620px){.st-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}",
    "@media(max-width:560px){",
    "#st-overlay{padding:0;align-items:stretch}",
    "#st-box{width:100%;max-height:100vh;border-radius:0;border:0;padding:10px 12px 18px}",
    ".st-head{gap:6px}#st-box h3{font-size:15.5px}",
    "#st-close{position:fixed;top:10px;right:12px;z-index:5;background:var(--bg-2,#1b1b1b);width:34px;height:34px;font-size:17px}",
    ".st-seg{margin-left:0;flex-wrap:wrap}.st-seg button{padding:5px 10px;font-size:12px}",
    ".st-kpis{gap:6px}",
    ".st-kpi{padding:7px 9px}.st-kpi .v{font-size:17px}.st-kpi .k{font-size:9.5px}.st-kpi .s{font-size:10.5px}",
    ".st-hide-sm{display:none}",
    "table.st-t{font-size:12.5px}table.st-t thead{display:none}",
    "table.st-t tr{display:block;padding:8px 0;border-bottom:1px solid var(--line,#2a2a2a)}",
    "table.st-t td{display:flex;justify-content:space-between;gap:10px;border:0;padding:1px 0;text-align:right;white-space:normal}",
    "table.st-t td::before{content:attr(data-label);opacity:.5;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase}",
    "table.st-t td:first-child{display:block;text-align:left;font-size:13px;margin-bottom:3px}",
    "table.st-t td:first-child::before{content:none}",
    ".st-bars{height:70px}.st-hbars{height:34px}",
    ".st-sec{margin:13px 0 4px}",
    "}"
  ].join("");
  var el = null;
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function(c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
    });
  }
  function usd(v) {
    if (v == null || !isFinite(v)) return "—";
    if (v === 0) return "USD 0";
    if (v < 0.01) return "USD " + v.toFixed(4);
    if (v < 1) return "USD " + v.toFixed(3);
    return "USD " + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "");
  }
  function tok(v) {
    if (v == null) return "—";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + " B";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + " M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + " k";
    return String(v);
  }
  function pct(v) {
    return v == null || !isFinite(v) ? "—" : v.toFixed(1) + "%";
  }
  function fecha(ts) {
    if (!ts) return "";
    var d = new Date(ts * 1e3);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString().slice(0, 5);
  }
  function build() {
    var st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
    var d = document.createElement("div");
    d.id = "st-overlay";
    d.innerHTML = [
      '<div id="st-box">',
      '  <div class="st-head">',
      "    <h3>Gasto y uso</h3>",
      '    <button id="st-close" class="st-x" type="button" aria-label="Cerrar" title="Cerrar (Esc)">✕</button>',
      '    <div class="st-seg" id="st-seg">',
      RANGOS.map(function(r) {
        return '<button data-days="' + r.d + '"' + (r.d === dias ? ' data-on="1"' : "") + ">" + r.label + "</button>";
      }).join(""),
      "    </div>",
      '    <button class="st-seg" id="st-reload" style="margin:0;border:0"><span title="Actualizar" aria-label="Actualizar" style="border:1px solid var(--line,#3a3a3a);border-radius:7px;padding:4px 10px;display:inline-block;font-size:13px">↻</span></button>',
      "  </div>",
      '  <div class="st-sub" id="st-sub">leyendo sessions.db…</div>',
      '  <div id="st-body"></div>',
      "</div>"
    ].join("");
    document.body.appendChild(d);
    d.addEventListener("click", function(e) {
      if (e.target === d) close();
    });
    d.querySelectorAll("#st-seg button").forEach(function(b) {
      b.onclick = function() {
        dias = Number(b.getAttribute("data-days")) || 0;
        d.querySelectorAll("#st-seg button").forEach(function(x) {
          x.setAttribute("data-on", x === b ? "1" : "0");
        });
        datos = null;
        load();
      };
    });
    d.querySelector("#st-reload").onclick = function() {
      datos = null;
      load();
    };
    d.querySelector("#st-close").onclick = function() {
      close();
    };
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape" && d.dataset.open === "1") close();
    });
    el = d;
    return d;
  }
  function node() {
    return el || build();
  }
  function open() {
    var d = node();
    d.dataset.open = "1";
    load();
  }
  function close() {
    if (el) el.dataset.open = "0";
  }
  function sub(msg, bad) {
    var s = node().querySelector("#st-sub");
    s.textContent = msg;
    s.className = bad ? "st-sub st-err" : "st-sub";
  }
  function load() {
    if (cargando) return;
    if (datos) {
      render(datos);
      return;
    }
    cargando = true;
    sub("agregando usage_ledger…");
    fetch("/stats.json?days=" + dias, { credentials: "same-origin" }).then(function(r) {
      return r.json();
    }).then(function(d) {
      cargando = false;
      if (d && d._error) {
        sub("no se pudo leer el historial: " + d._error, true);
        return;
      }
      datos = d;
      render(d);
    }).catch(function(e) {
      cargando = false;
      sub("error: " + (e && e.message || e), true);
    });
  }
  function barras(serie) {
    var max = 0;
    serie.forEach(function(p) {
      if (p.cost > max) max = p.cost;
    });
    if (!max) return '<div class="st-axis">sin gasto en el rango</div>';
    return '<div class="st-bars">' + serie.map(function(p) {
      var h = Math.max(1, Math.round(p.cost / max * 92));
      return '<div class="b" style="height:' + h + 'px" title="' + esc(p.d) + " · " + esc(usd(p.cost)) + " · " + p.calls + " llamadas · " + esc(tok(p.input + p.output)) + ' tokens"></div>';
    }).join("") + '</div><div class="st-axis"><span>' + esc(serie[0] ? serie[0].d : "") + "</span><span>pico " + esc(usd(max)) + "</span><span>" + esc(serie[serie.length - 1] ? serie[serie.length - 1].d : "") + "</span></div>";
  }
  function render(d) {
    var t = d.totals || {};
    var box = node().querySelector("#st-body");
    sub("rango: " + (d.days ? "últimos " + d.days + " días" : "todo el historial") + " · " + t.calls + " llamadas · " + t.sessions + " sesiones");
    var kpis = [
      { k: "Gasto", v: usd(t.cost), s: t.withCostCalls + " llamadas con costo" },
      { k: "Llamadas", v: tok(t.calls), s: t.sessions + " sesiones" },
      { k: "Entrada", v: tok(t.input), s: "cache hit " + pct(t.cacheHitPct) },
      { k: "Salida", v: tok(t.output), s: "media " + tok(t.avgTokensPerCall) + "/llamada" },
      { k: "Costo medio", v: usd(t.avgCostPerCall), s: "p95 " + usd(d.percentiles && d.percentiles.p95) },
      { k: "Compactación", v: usd(t.compactionCost), s: (t.compactionCalls || 0) + " llamadas internas" }
    ];
    var html = '<div class="st-kpis">' + kpis.map(function(x) {
      return '<div class="st-kpi"><div class="k">' + esc(x.k) + '</div><div class="v">' + esc(x.v) + '</div><div class="s">' + esc(x.s) + "</div></div>";
    }).join("") + "</div>";
    html += '<div class="st-sec">Gasto por día</div>' + barras(d.daily || []);
    var modelos = (d.models || []).slice(0, 12);
    var maxCost = 0;
    modelos.forEach(function(m) {
      if (m.cost > maxCost) maxCost = m.cost;
    });
    html += '<div class="st-sec">Por modelo</div><table class="st-t"><thead><tr><th>Modelo</th><th>Llamadas</th><th>Entrada</th><th>Salida</th><th class="st-hide-sm">Cache</th><th>Costo</th><th>% del gasto</th></tr></thead><tbody>' + modelos.map(function(m) {
      var w = maxCost ? Math.max(2, Math.round(m.cost / maxCost * 100)) : 0;
      return '<tr><td><span class="st-model"><b>' + esc(m.model) + '</b><span class="st-mini" style="width:' + w + 'px"></span></span></td><td data-label="Llamadas">' + tok(m.calls) + '</td><td data-label="Entrada">' + tok(m.input) + '</td><td data-label="Salida">' + tok(m.output) + '</td><td class="st-hide-sm" data-label="Cache">' + pct(m.cacheHitPct) + '</td><td data-label="Costo">' + esc(usd(m.cost)) + '</td><td data-label="% del gasto">' + pct(m.share) + "</td></tr>";
    }).join("") + "</tbody></table>";
    var sinCosto = (d.models || []).filter(function(m) {
      return m.noCostCalls > 0;
    });
    if (sinCosto.length) {
      html += '<div class="st-warn">Sin precio en la tabla: ' + sinCosto.map(function(m) {
        return esc(m.model) + " (" + m.noCostCalls + ")";
      }).join(", ") + ". Esas llamadas cuentan tokens pero no costo.</div>";
    }
    html += '<div class="st-sec">Sesiones más caras</div><table class="st-t"><thead><tr><th>Sesión</th><th class="st-hide-sm">Llamadas</th><th class="st-hide-sm">Entrada</th><th>Costo</th><th class="st-hide-sm">Última</th></tr></thead><tbody>' + (d.sessions || []).map(function(s) {
      return "<tr><td>" + esc(s.name || s.sid) + (s.name ? ' <span style="opacity:.45;margin-left:6px;font-size:11.5px">' + esc(s.sid) + "</span>" : "") + '</td><td class="st-hide-sm" data-label="Llamadas">' + tok(s.calls) + '</td><td class="st-hide-sm" data-label="Entrada">' + tok(s.input) + '</td><td data-label="Costo">' + esc(usd(s.cost)) + '</td><td class="st-hide-sm" data-label="Última" style="opacity:.6">' + esc(fecha(s.lastTs)) + "</td></tr>";
    }).join("") + "</tbody></table>";
    var horas = d.hours || [];
    var maxH = 0;
    horas.forEach(function(h) {
      if (h.calls > maxH) maxH = h.calls;
    });
    html += '<div class="st-sec">Actividad por hora del día</div><div class="st-hbars">' + horas.map(function(h) {
      var hh = maxH ? Math.max(1, Math.round(h.calls / maxH * 42)) : 1;
      return '<div class="b" style="height:' + hh + 'px" title="' + String(h.h).padStart(2, "0") + ":00 · " + h.calls + " llamadas · " + esc(usd(h.cost)) + '"></div>';
    }).join("") + '</div><div class="st-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>';
    var fuentes = (d.costSources || []).map(function(s) {
      return esc(s.source) + ": " + s.calls;
    }).join(" · ");
    html += '<div class="st-foot"><span>percentiles por llamada: p50 ' + esc(usd(d.percentiles && d.percentiles.p50)) + " · p95 " + esc(usd(d.percentiles && d.percentiles.p95)) + " · máx " + esc(usd(d.percentiles && d.percentiles.max)) + "</span><span>origen del costo — " + fuentes + "</span><span>sesiones con más de un modelo: " + (d.modelMix && d.modelMix.multi || 0) + " de " + (d.modelMix && d.modelMix.sessions || 0) + "</span><span>generado " + esc(fecha(Math.floor(new Date(d.generatedAt).getTime() / 1e3))) + "</span></div>";
    box.innerHTML = html;
  }
  function button() {
    var top = document.getElementById("btn-goals");
    if (!top || document.getElementById("btn-gasto-top")) return;
    var t = document.createElement("button");
    t.id = "btn-gasto-top";
    t.className = top.className;
    t.title = "Gasto y estadísticas de uso";
    t.setAttribute("aria-label", "Gasto y estadísticas de uso");
    t.innerHTML = '<svg width="17" height="17" viewBox="0 0 20 20" fill="none"><path d="M3 16V9M7.6 16V4M12.2 16v-5M16.8 16V7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    t.onclick = open;
    top.insertAdjacentElement("beforebegin", t);
  }
  button();
  window.__aegisStats = { open, close, load };
})();
