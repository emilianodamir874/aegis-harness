(function() {
  "use strict";
  var RANGOS = [
    { d: 7, label: "7 días" },
    { d: 30, label: "30 días" },
    { d: 90, label: "90 días" },
    { d: 0, label: "Todo" }
  ];
  var dias = 30;
  var datos = null;
  var cargando = false;
  var CSS = [
    ".st-sec{display:flex;align-items:baseline;gap:8px;margin:22px 0 8px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3)}",
    ".st-sec small{font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--text-4)}",
    ".st-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}",
    ".st-kpi{border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;background:var(--bg-raise)}",
    ".st-kpi .k{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-4);font-weight:600}",
    ".st-kpi .v{font-size:19px;font-weight:600;margin-top:3px;font-variant-numeric:tabular-nums;letter-spacing:-.01em}",
    ".st-kpi .s{font-size:11.5px;color:var(--text-3);margin-top:1px;font-variant-numeric:tabular-nums}",
    ".st-bars{display:flex;align-items:flex-end;gap:2px;height:104px;padding:6px 0 0;border-bottom:1px solid var(--border)}",
    ".st-bars .b{flex:1;min-width:2px;background:var(--accent);opacity:.55;border-radius:2px 2px 0 0;min-height:1px;transition:opacity .12s ease}",
    ".st-bars .b:hover{opacity:1}",
    ".st-axis{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--text-4);margin-top:5px;font-variant-numeric:tabular-nums}",
    ".st-hbars{display:flex;align-items:flex-end;gap:2px;height:46px;border-bottom:1px solid var(--border)}",
    ".st-hbars .b{flex:1;background:var(--text-3);opacity:.45;border-radius:1px;min-height:1px}",
    ".st-hbars .b:hover{opacity:.9}",
    "table.st-t{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}",
    "table.st-t th{text-align:right;font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-4);padding:6px 8px;border-bottom:1px solid var(--border);white-space:nowrap;position:sticky;top:0;background:var(--bg-card);z-index:1}",
    "table.st-t th:first-child,table.st-t td:first-child{text-align:left}",
    "table.st-t td{padding:6px 8px;border-bottom:1px solid var(--border-soft);text-align:right;white-space:nowrap}",
    "table.st-t tbody tr:hover td{background:rgba(245,244,239,.035)}",
    ".st-model{display:flex;flex-direction:column;gap:3px;align-items:flex-start;min-width:0}",
    ".st-model b{font-weight:550}",
    ".st-mini{height:2px;border-radius:2px;background:var(--accent);opacity:.38;max-width:100%}",
    ".st-warn{font-size:11.5px;color:var(--warn);margin-top:8px;line-height:1.5}",
    ".st-plan-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;margin-top:10px;font-size:13px}",
    ".st-plan-line b{font-weight:600;font-variant-numeric:tabular-nums}",
    ".st-plan-line span{font-size:11.5px;color:var(--text-4)}",
    ".st-foot{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11.5px;color:var(--text-4);margin-top:18px;border-top:1px solid var(--border);padding-top:12px;line-height:1.5}",
    ".st-err{color:var(--danger);font-size:12.5px;white-space:pre-wrap}",
    ".st-empty{padding:26px 8px;text-align:center;color:var(--text-3);font-size:13px}",
    "@media(max-width:820px){.st-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}",
    "@media(max-width:620px){.st-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.st-kpi .v{font-size:17px}}",
    "@media(max-width:560px){",
    ".st-hide-sm{display:none}",
    ".st-kpis{gap:6px}.st-kpi{padding:8px 10px}.st-kpi .k{font-size:9.5px}",
    "table.st-t{font-size:12.5px}table.st-t thead{display:none}",
    "table.st-t tr{display:block;padding:9px 0;border-bottom:1px solid var(--border-soft)}",
    "table.st-t td{display:flex;justify-content:space-between;gap:10px;border:0;padding:1.5px 0;text-align:right;white-space:normal}",
    "table.st-t td::before{content:attr(data-label);color:var(--text-4);font-size:10.5px;letter-spacing:.04em;text-transform:uppercase}",
    "table.st-t td:first-child{display:block;text-align:left;font-size:13px;margin-bottom:4px}",
    "table.st-t td:first-child::before{content:none}",
    ".st-bars{height:74px}.st-hbars{height:36px}",
    ".st-mini{display:none}",
    ".st-sec{margin:16px 0 6px}",
    "}"
  ].join("");
  var el = null;
  var lastFocus = null;
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
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function(c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
    });
  }
  function usdDelta(v) {
    if (v == null || !isFinite(v)) return "—";
    if (Math.abs(v) < 5e-3) return "empate";
    return (v > 0 ? "+" : "−") + usd(Math.abs(v));
  }
  function build() {
    var st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
    var d = document.createElement("div");
    d.id = "st-overlay";
    d.className = "xpanel-overlay";
    d.dataset.open = "0";
    d.innerHTML = [
      '<div id="st-box" class="xpanel st-box" role="dialog" aria-modal="true" aria-labelledby="st-title" tabindex="-1">',
      '  <header class="xpanel-head st-head">',
      '    <h2 id="st-title">Gasto y uso</h2>',
      '    <div class="st-seg" id="st-seg" role="group" aria-label="Rango de tiempo">',
      RANGOS.map(function(r) {
        return '<button type="button" data-days="' + r.d + '"' + (r.d === dias ? ' data-on="1" aria-pressed="true"' : ' aria-pressed="false"') + ">" + r.label + "</button>";
      }).join(""),
      "    </div>",
      '    <button id="st-reload" class="xpanel-close" type="button" aria-label="Actualizar datos" title="Actualizar">↻</button>',
      '    <button id="st-close" class="xpanel-close" type="button" aria-label="Cerrar panel de gasto" title="Cerrar (Esc)">✕</button>',
      "  </header>",
      '  <div class="st-body">',
      '    <div class="st-sub" id="st-sub" role="status" aria-live="polite">leyendo sessions.db…</div>',
      '    <div id="st-body-content"></div>',
      "  </div>",
      "</div>"
    ].join("");
    document.body.appendChild(d);
    d.addEventListener("mousedown", function(e) {
      if (e.target === d) close();
    });
    var seg = d.querySelector("#st-seg");
    seg.addEventListener("click", function(e) {
      var b = e.target.closest("button");
      if (!b) return;
      dias = Number(b.getAttribute("data-days")) || 0;
      seg.querySelectorAll("button").forEach(function(x) {
        var on = x === b;
        x.setAttribute("data-on", on ? "1" : "0");
        x.setAttribute("aria-pressed", on ? "true" : "false");
      });
      datos = null;
      load();
    });
    d.querySelector("#st-reload").onclick = function() {
      datos = null;
      load();
    };
    d.querySelector("#st-close").onclick = function() {
      close();
    };
    d.addEventListener("keydown", function(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      var f = [...d.querySelectorAll("button:not([disabled])")].filter(function(n) {
        return n.offsetParent !== null;
      });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    });
    el = d;
    return d;
  }
  function node() {
    return el || build();
  }
  function open() {
    var d = node();
    lastFocus = document.activeElement;
    d.dataset.open = "1";
    load();
    setTimeout(function() {
      document.getElementById("st-box")?.focus();
    }, 30);
  }
  function close() {
    if (!el) return;
    el.dataset.open = "0";
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
    lastFocus = null;
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
        sub("No se pudo leer el historial: " + d._error, true);
        return;
      }
      datos = d;
      render(d);
    }).catch(function(e) {
      cargando = false;
      sub("Error al leer /stats.json: " + (e && e.message || e), true);
    });
  }
  function barras(serie) {
    var max = 0;
    serie.forEach(function(p) {
      if (p.cost > max) max = p.cost;
    });
    if (!max) return '<div class="st-empty">Sin gasto en el rango.</div>';
    var total = serie.reduce(function(a, p) {
      return a + (p.cost || 0);
    }, 0);
    return '<div class="st-bars" role="img" aria-label="Gasto diario: ' + serie.length + " días, total " + esc(usd(total)) + ", pico " + esc(usd(max)) + '">' + serie.map(function(p) {
      var h = Math.max(1, Math.round(p.cost / max * 98));
      return '<div class="b" style="height:' + h + 'px" title="' + esc(p.d) + " · " + esc(usd(p.cost)) + " · " + p.calls + " llamadas · " + esc(tok(p.input + p.output)) + ' tokens"></div>';
    }).join("") + '</div><div class="st-axis"><span>' + esc(serie[0] ? serie[0].d : "") + "</span><span>pico " + esc(usd(max)) + "</span><span>" + esc(serie[serie.length - 1] ? serie[serie.length - 1].d : "") + "</span></div>";
  }
  function seccionPlan(d) {
    var filas = d.byProvider || [];
    var vp = d.vsPlan || { providers: 0, declared: 0, estimatedUsd: 0, planUsd: 0, deltaUsd: 0 };
    var pw = d.planWindow || {};
    var detalle = pw.prorated ? "plan prorrateado: " + Math.round(pw.periodDays) + " de " + pw.daysInMonth + " días" : "plan del mes completo";
    var h = '<div class="st-sec">Contra el plan <small>consumo valuado a tarifa API vs lo que pagás</small></div>';
    if (!filas.length) return h + '<div class="st-empty">Sin datos en el período.</div>';
    h += '<table class="st-t"><thead><tr><th>Proveedor</th><th class="st-hide-sm">Llamadas</th><th>Consumo estimado</th><th>Plan del período</th><th>Diferencia</th></tr></thead><tbody>';
    filas.forEach(function(f) {
      var col = f.deltaUsd == null ? "" : ' style="color:' + (f.deltaUsd >= 0 ? "var(--ok)" : "var(--danger)") + '"';
      h += '<tr><td><span class="st-model"><b>' + esc(f.label || f.provider) + "</b>" + (f.note ? '<span style="font-size:11px;color:var(--text-4)">' + esc(f.note) + "</span>" : "") + '</span></td><td class="st-hide-sm" data-label="Llamadas">' + tok(f.calls) + '</td><td data-label="Consumo estimado">' + esc(usd(f.estimatedUsd)) + '</td><td data-label="Plan del período">' + (f.planUsd == null ? "—" : esc(usd(f.planUsd))) + '</td><td data-label="Diferencia"' + col + ">" + esc(usdDelta(f.deltaUsd)) + "</td></tr>";
    });
    h += "</tbody></table>";
    if (!vp.declared) {
      h += '<div class="st-warn">Declará el plan en config.json (bloque «plans»): sin monthly_usd no se calcula la diferencia.</div>';
    } else {
      var favor = (vp.deltaUsd || 0) >= 0;
      h += '<div class="st-plan-line">contra planes: <b>' + esc(usdDelta(vp.deltaUsd)) + "</b> " + (favor ? "a favor" : "en contra") + " <span>" + esc(usd(vp.estimatedUsd)) + " de consumo vs " + esc(usd(vp.planUsd)) + " de plan · " + esc(detalle) + "</span></div>";
    }
    var up = d.unknownProvider;
    if (up && up.calls) {
      h += '<div class="st-warn">sin proveedor: ' + tok(up.calls) + " llamadas (" + esc(usd(up.estimatedUsd)) + "). El ledger no registró el proveedor en esas filas, así que no se pueden comparar contra un plan.</div>";
    }
    return h;
  }
  function render(d) {
    var t = d.totals || {};
    var box = node().querySelector("#st-body-content");
    sub("rango: " + (d.days ? "últimos " + d.days + " días" : "todo el historial") + " · " + t.calls + " llamadas · " + t.sessions + " sesiones");
    var kpis = [
      { k: "Costo estimado", v: usd(t.cost), s: t.withCostCalls + " llamadas con costo" },
      { k: "Llamadas", v: tok(t.calls), s: t.sessions + " sesiones" },
      { k: "Entrada", v: tok(t.input), s: "cache hit " + pct(t.cacheHitPct) },
      { k: "Salida", v: tok(t.output), s: "media " + tok(t.avgTokensPerCall) + "/llamada" },
      { k: "Costo medio", v: usd(t.avgCostPerCall), s: "p95 " + usd(d.percentiles && d.percentiles.p95) },
      { k: "Compactación", v: usd(t.compactionCost), s: (t.compactionCalls || 0) + " llamadas internas" }
    ];
    var html = '<div class="st-kpis">' + kpis.map(function(x) {
      return '<div class="st-kpi"><div class="k">' + esc(x.k) + '</div><div class="v">' + esc(x.v) + '</div><div class="s">' + esc(x.s) + "</div></div>";
    }).join("") + "</div>";
    html += seccionPlan(d);
    html += '<div class="st-sec">Gasto por día <small>costo por día en el rango</small></div>' + barras(d.daily || []);
    var modelos = (d.models || []).slice(0, 12);
    var maxCost = 0;
    modelos.forEach(function(m) {
      if (m.cost > maxCost) maxCost = m.cost;
    });
    html += '<div class="st-sec">Por modelo <small>ordenado por costo</small></div><table class="st-t"><thead><tr><th>Modelo</th><th>Llamadas</th><th>Entrada</th><th>Salida</th><th class="st-hide-sm">Cache</th><th>Costo</th><th>% del gasto</th></tr></thead><tbody>' + modelos.map(function(m) {
      var w = maxCost ? Math.max(2, Math.round(m.cost / maxCost * 100)) : 0;
      return '<tr><td><span class="st-model"><b>' + esc(m.model) + '</b><span class="st-mini" style="width:' + w + '%"></span></span></td><td data-label="Llamadas">' + tok(m.calls) + '</td><td data-label="Entrada">' + tok(m.input) + '</td><td data-label="Salida">' + tok(m.output) + '</td><td class="st-hide-sm" data-label="Cache">' + pct(m.cacheHitPct) + '</td><td data-label="Costo">' + esc(usd(m.cost)) + '</td><td data-label="% del gasto">' + pct(m.share) + "</td></tr>";
    }).join("") + "</tbody></table>";
    var sinCosto = (d.models || []).filter(function(m) {
      return m.noCostCalls > 0;
    });
    if (sinCosto.length) {
      html += '<div class="st-warn">Sin precio en la tabla: ' + sinCosto.map(function(m) {
        return esc(m.model) + " (" + m.noCostCalls + ")";
      }).join(", ") + ". Esas llamadas cuentan tokens pero no costo.</div>";
    }
    html += '<div class="st-sec">Sesiones más caras <small>top 12 por costo</small></div><table class="st-t"><thead><tr><th>Sesión</th><th class="st-hide-sm">Llamadas</th><th class="st-hide-sm">Entrada</th><th>Costo</th><th class="st-hide-sm">Última</th></tr></thead><tbody>' + (d.sessions || []).map(function(s) {
      return "<tr><td>" + esc(s.name || s.sid) + (s.name ? ' <span style="color:var(--text-4);margin-left:6px;font-size:11.5px">' + esc(s.sid) + "</span>" : "") + '</td><td class="st-hide-sm" data-label="Llamadas">' + tok(s.calls) + '</td><td class="st-hide-sm" data-label="Entrada">' + tok(s.input) + '</td><td data-label="Costo">' + esc(usd(s.cost)) + '</td><td class="st-hide-sm" data-label="Última" style="color:var(--text-4)">' + esc(fecha(s.lastTs)) + "</td></tr>";
    }).join("") + "</tbody></table>";
    var horas = d.hours || [];
    var maxH = 0;
    horas.forEach(function(h) {
      if (h.calls > maxH) maxH = h.calls;
    });
    html += '<div class="st-sec">Actividad por hora del día</div><div class="st-hbars" role="img" aria-label="Llamadas por hora del día">' + horas.map(function(h) {
      var hh = maxH ? Math.max(1, Math.round(h.calls / maxH * 34)) : 1;
      return '<div class="b" style="height:' + hh + 'px" title="' + String(h.h).padStart(2, "0") + ":00 · " + h.calls + " llamadas · " + esc(usd(h.cost)) + '"></div>';
    }).join("") + '</div><div class="st-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>';
    var fuentes = (d.costSources || []).map(function(s) {
      return esc(s.source) + ": " + s.calls;
    }).join(" · ");
    html += '<div class="st-foot"><span>percentiles por llamada: p50 ' + esc(usd(d.percentiles && d.percentiles.p50)) + " · p95 " + esc(usd(d.percentiles && d.percentiles.p95)) + " · máx " + esc(usd(d.percentiles && d.percentiles.max)) + "</span><span>origen del costo — " + fuentes + "</span><span>costo estimado por catálogo de precios: es valuación, no factura</span><span>sesiones con más de un modelo: " + (d.modelMix && d.modelMix.multi || 0) + " de " + (d.modelMix && d.modelMix.sessions || 0) + "</span><span>generado " + esc(fecha(Math.floor(new Date(d.generatedAt).getTime() / 1e3))) + "</span></div>";
    box.innerHTML = html;
  }
  function button() {
    var top = document.getElementById("btn-goals");
    if (!top || document.getElementById("btn-gasto-top")) return;
    var t = document.createElement("button");
    t.id = "btn-gasto-top";
    t.className = top.className;
    t.type = "button";
    t.title = "Gasto y estadísticas de uso";
    t.setAttribute("aria-label", "Gasto y estadísticas de uso");
    t.setAttribute("aria-haspopup", "dialog");
    t.innerHTML = '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 16V9M7.6 16V4M12.2 16v-5M16.8 16V7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    t.onclick = open;
    top.insertAdjacentElement("beforebegin", t);
  }
  button();
  window.__aegisStats = { open, close, load };
})();
