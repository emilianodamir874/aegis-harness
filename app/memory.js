// src/app/acts.ts
var abierto = null;
var disparador = null;
var MARGEN = 8;
function cerca(sel) {
  return document.querySelector(sel);
}
function cerrarAcciones() {
  document.querySelectorAll("body > .acts-menu").forEach((m) => m.remove());
  if (disparador && disparador.isConnected) disparador.setAttribute("aria-expanded", "false");
  abierto = null;
  disparador = null;
}
function medir(menu, r, lateral, fila) {
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let left;
  let top;
  if (lateral && fila) {
    left = fila.right + 6;
    if (left + w > window.innerWidth - MARGEN) left = fila.left - w - 6;
    top = fila.top;
    if (left < MARGEN) {
      left = Math.min(Math.max(MARGEN, fila.left), Math.max(MARGEN, window.innerWidth - MARGEN - w));
      top = fila.bottom + 6;
    }
  } else {
    left = r.right - w;
    if (left < MARGEN) left = MARGEN;
    top = r.bottom + 7;
    if (top + h > window.innerHeight - MARGEN) top = Math.max(MARGEN, r.top - h - 7);
    else if (r.bottom + 7 + h > window.innerHeight - MARGEN) top = Math.max(MARGEN, r.top - h - 7);
  }
  if (top + h > window.innerHeight - MARGEN) top = Math.max(MARGEN, window.innerHeight - MARGEN - h);
  if (top < MARGEN) top = MARGEN;
  if (left + w > window.innerWidth - MARGEN) left = Math.max(MARGEN, window.innerWidth - MARGEN - w);
  menu.style.left = Math.round(left) + "px";
  menu.style.top = Math.round(top) + "px";
  menu.style.maxHeight = Math.max(120, window.innerHeight - 2 * MARGEN) + "px";
}
function filas(menu) {
  return [...menu.querySelectorAll(":scope > .menu-row:not([disabled])")];
}
function pintar(items, nivel) {
  const menu = document.createElement("div");
  menu.className = "menu acts-menu" + (nivel === "sub" ? " acts-sub" : "");
  menu.setAttribute("role", "menu");
  for (const it of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "menu-row" + (it.danger ? " danger" : "");
    row.setAttribute("role", "menuitem");
    row.innerHTML = '<span class="act-main">' + (it.icon ? '<span class="act-ico">' + it.icon + "</span>" : "") + '<span class="act-t">' + it.label + "</span>" + (it.hint ? '<span class="act-hint">' + it.hint + "</span>" : "") + "</span>" + (it.sub ? '<span class="act-chev" aria-hidden="true"><svg viewBox="0 0 12 12" width="11" height="11" fill="none"><path d="M4.5 2.8 7.7 6l-3.2 3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' : "");
    if (it.sub) {
      row.setAttribute("aria-haspopup", "menu");
      row.setAttribute("aria-expanded", "false");
      const abrirSub = () => {
        if (row.classList.contains("act-open")) return;
        cerrarSub(menu);
        const sub = pintar(it.sub, "sub");
        sub.dataset.parent = "1";
        document.body.appendChild(sub);
        menu.dataset.sub = "1";
        row.classList.add("act-open");
        row.setAttribute("aria-expanded", "true");
        medir(sub, row.getBoundingClientRect(), true, row.getBoundingClientRect());
        abierto = sub;
        const first = filas(sub)[0];
        if (first && menu.dataset.kbd === "1") first.focus({ preventScroll: true });
      };
      const cerrarEste = () => {
        cerrarSub(menu);
        row.classList.remove("act-open");
        row.setAttribute("aria-expanded", "false");
      };
      row.addEventListener("pointerenter", abrirSub);
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        if (row.classList.contains("act-open")) {
          cerrarEste();
          return;
        }
        abrirSub();
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          abrirSub();
          const f = filas(menu.dataset.sub === "1" ? abierto || menu : menu)[0];
          f?.focus();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cerrarEste();
        }
      });
    } else {
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        const fn = it.run;
        cerrarAcciones();
        fn?.();
      });
    }
    menu.appendChild(row);
  }
  if (nivel === "menu") {
    menu.addEventListener("keydown", (e) => {
      const items2 = filas(menu);
      const i = items2.indexOf(document.activeElement);
      const ir = (n) => {
        e.preventDefault();
        items2[(i + n + items2.length) % items2.length].focus();
      };
      if (e.key === "ArrowDown") ir(1);
      else if (e.key === "ArrowUp") ir(-1);
      else if (e.key === "Home") {
        e.preventDefault();
        items2[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        items2[items2.length - 1]?.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const back = disparador;
        cerrarAcciones();
        if (back && back.isConnected) back.focus();
      }
    });
  } else {
    menu.addEventListener("keydown", (e) => {
      const items2 = filas(menu);
      const i = items2.indexOf(document.activeElement);
      const ir = (n) => {
        e.preventDefault();
        items2[(i + n + items2.length) % items2.length].focus();
      };
      if (e.key === "ArrowDown") ir(1);
      else if (e.key === "ArrowUp") ir(-1);
      else if (e.key === "Escape" || e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        const padre = cerca("body > .acts-menu:not(.acts-sub)");
        cerrarSub();
        const fila = padre?.querySelector(".menu-row.act-open");
        fila?.classList.remove("act-open");
        fila?.setAttribute("aria-expanded", "false");
        (fila || disparador)?.focus();
      }
    });
  }
  return menu;
}
function cerrarSub(scope) {
  document.querySelectorAll("body > .acts-sub").forEach((m) => m.remove());
  (scope || document).querySelectorAll(".menu-row.act-open").forEach((r) => {
    r.classList.remove("act-open");
    r.setAttribute("aria-expanded", "false");
  });
}
function abrirAcciones(trigger, items) {
  cerrarAcciones();
  if (!items.length) return;
  disparador = trigger;
  trigger.setAttribute("aria-expanded", "true");
  const menu = pintar(items, "menu");
  document.body.appendChild(menu);
  abierto = menu;
  medir(menu, trigger.getBoundingClientRect(), false);
  const porTeclado = document.documentElement.dataset.kbd === "1" || !!trigger.dataset.kbd;
  if (porTeclado) filas(menu)[0]?.focus({ preventScroll: true });
}
function botonAcciones(etiqueta, items, extraClass = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "act-btn" + (extraClass ? " " + extraClass : "");
  b.setAttribute("aria-label", "Acciones: " + etiqueta);
  b.setAttribute("aria-haspopup", "menu");
  b.setAttribute("aria-expanded", "false");
  b.title = "Acciones";
  b.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.4" cy="8" r="1.35" fill="currentColor"/><circle cx="8" cy="8" r="1.35" fill="currentColor"/><circle cx="12.6" cy="8" r="1.35" fill="currentColor"/></svg>';
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    const ya = abierto && disparador === b;
    if (ya) {
      cerrarAcciones();
      return;
    }
    abrirAcciones(b, items());
  });
  b.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      b.dataset.kbd = "1";
      abrirAcciones(b, items());
      delete b.dataset.kbd;
    }
  });
  return b;
}

// src/memory.ts
var STATUS_LABEL = {
  confirmed: "confirmado",
  candidate: "candidato",
  rejected: "rechazado",
  stale: "archivado"
};
var STATUS_BADGE = {
  confirmed: "ok",
  candidate: "warn",
  rejected: "bad",
  stale: "muted"
};
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  if (text !== void 0) node.textContent = text;
  return node;
}
var CSS = `
.aegis-mem-backdrop{position:fixed;inset:0;background:rgba(6,8,12,.62);backdrop-filter:blur(2px);z-index:9100;display:flex;align-items:center;justify-content:center;padding:24px}
.aegis-mem{width:min(920px,100%);max-height:min(86vh,900px);display:flex;flex-direction:column;background:var(--panel,#14181f);color:var(--fg,#e7edf5);border:1px solid rgba(255,255,255,.08);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.55);font:14px/1.45 system-ui,Segoe UI,sans-serif;overflow:hidden}
.aegis-mem header{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.07)}
.aegis-mem header h2{margin:0;font-size:16px;font-weight:650;letter-spacing:.2px}
.aegis-mem header .counts{color:#93a2b8;font-size:12px}
.aegis-mem header .grow{flex:1}
.aegis-mem button{cursor:pointer;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:5px 10px;font:inherit}
.aegis-mem button:hover{background:rgba(255,255,255,.12)}
.aegis-mem button.primary{background:#2f6df6;border-color:#2f6df6;color:#fff}
.aegis-mem .toolbar{display:flex;gap:8px;align-items:center;padding:10px 18px;border-bottom:1px solid rgba(255,255,255,.07);flex-wrap:wrap}
.aegis-mem .toolbar input[type=text]{flex:1;min-width:220px;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.12);color:inherit;border-radius:8px;padding:7px 10px;font:inherit}
.aegis-mem .toolbar select{background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.12);color:inherit;border-radius:8px;padding:7px 8px;font:inherit}
.aegis-mem .list{overflow:auto;padding:6px 10px 14px}
.aegis-mem .fact{display:grid;grid-template-columns:1fr auto;gap:10px;padding:10px 8px;border-bottom:1px solid rgba(255,255,255,.05)}
.aegis-mem .fact .text{white-space:pre-wrap;word-break:break-word}
.aegis-mem .meta{margin-top:4px;color:#93a2b8;font-size:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.aegis-mem .badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid currentColor}
.aegis-mem .badge.ok{color:#4ade80}
.aegis-mem .badge.warn{color:#fbbf24}
.aegis-mem .badge.bad{color:#f87171}
.aegis-mem .badge.muted{color:#94a3b8}
.aegis-mem .actions{display:flex;gap:6px;align-items:flex-start}
.aegis-mem .empty{padding:28px;text-align:center;color:#93a2b8}
.aegis-mem .status{padding:0 18px 12px;color:#93a2b8;font-size:12px;min-height:18px}
`;
function ensureStyle() {
  if (document.getElementById("aegis-mem-style")) return;
  const style = el("style", { id: "aegis-mem-style" });
  style.textContent = CSS;
  document.head.appendChild(style);
}
function buildPanel() {
  const backdrop = el("div", { class: "aegis-mem-backdrop" });
  const panel = el("div", { class: "aegis-mem", role: "dialog", "aria-modal": "true", "aria-label": "Memoria del operador" });
  const header = el("header");
  header.appendChild(el("h2", {}, "Memoria del operador"));
  const counts = el("span", { class: "counts" }, "cargando…");
  header.appendChild(counts);
  header.appendChild(el("span", { class: "grow" }));
  const reload = el("button", { title: "Recargar" }, "Recargar");
  const close = el("button", { title: "Cerrar (Esc)" }, "Cerrar");
  header.appendChild(reload);
  header.appendChild(close);
  panel.appendChild(header);
  const toolbar = el("div", { class: "toolbar" });
  const filter = el("select", { title: "Filtrar por estado" });
  for (const [value, label] of [
    ["", "todos"],
    ["candidate", "candidatos"],
    ["confirmed", "confirmados"],
    ["rejected", "rechazados"],
    ["stale", "archivados"]
  ]) {
    const option = el("option", { value }, label);
    filter.appendChild(option);
  }
  const query = el("input", { type: "text", placeholder: "Buscar en el texto, la categoria o las etiquetas" });
  const addInput = el("input", { type: "text", placeholder: "Hecho nuevo: una frase, en imperativo o en presente" });
  const addButton = el("button", { class: "primary" }, "Agregar");
  const consolidate = el("button", { title: "Fusionar duplicados, promover candidatos y archivar lo viejo" }, "Consolidar");
  toolbar.append(filter, query, addInput, addButton, consolidate);
  panel.appendChild(toolbar);
  const list = el("div", { class: "list" });
  panel.appendChild(list);
  const status = el("div", { class: "status" });
  panel.appendChild(status);
  backdrop.appendChild(panel);
  close.addEventListener("click", () => closePanel());
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closePanel();
  });
  return { backdrop, list, counts, filter, query, status };
}
var mounted = null;
var facts = [];
var busy = false;
function say(message) {
  if (mounted) mounted.status.textContent = message;
}
async function api(body) {
  const response = await fetch("/memory.json", {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : void 0,
    cache: "no-store"
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  if (data.output) say(data.output.split("\n")[0]);
  return data;
}
function render() {
  if (!mounted) return;
  const filter = mounted.filter.value;
  const needle = mounted.query.value.trim().toLowerCase();
  const visible = facts.filter((fact) => {
    if (filter && (fact.status || "confirmed") !== filter) return false;
    if (!needle) return true;
    const haystack = `${fact.text} ${fact.kind || ""} ${(fact.tags || []).join(" ")}`.toLowerCase();
    return haystack.includes(needle);
  });
  const tally = { confirmed: 0, candidate: 0, rejected: 0, stale: 0 };
  for (const fact of facts) tally[fact.status || "confirmed"] = (tally[fact.status || "confirmed"] || 0) + 1;
  mounted.counts.textContent = `${facts.length} hechos · ${tally.confirmed} confirmados · ${tally.candidate} candidatos · ${tally.stale} archivados · ${tally.rejected} rechazados`;
  mounted.list.textContent = "";
  if (!visible.length) {
    mounted.list.appendChild(el("div", { class: "empty" }, "Nada para mostrar con este filtro."));
    return;
  }
  visible.sort((a, b) => {
    const pinned = Number(b.pinned === true) - Number(a.pinned === true);
    if (pinned !== 0) return pinned;
    return String(b.last_seen || b.updated || "").localeCompare(String(a.last_seen || a.updated || ""));
  });
  for (const fact of visible) {
    const row = el("div", { class: "fact" });
    const left = el("div");
    left.appendChild(el("div", { class: "text" }, fact.text));
    const meta = el("div", { class: "meta" });
    meta.appendChild(el("code", {}, fact.id));
    const status = fact.status || "confirmed";
    meta.appendChild(el("span", { class: `badge ${STATUS_BADGE[status] || "muted"}` }, STATUS_LABEL[status] || status));
    if (fact.pinned) meta.appendChild(el("span", { class: "badge ok" }, "fijado"));
    if (fact.confidence !== void 0) meta.appendChild(el("span", {}, `conf ${fact.confidence.toFixed(2)}`));
    if (fact.kind) meta.appendChild(el("span", {}, fact.kind));
    if (fact.source && fact.source !== "declared") meta.appendChild(el("span", {}, fact.source));
    const evidence = fact.evidence || [];
    if (evidence.length) {
      meta.appendChild(el("span", { title: evidence.join("\n") }, `evidencia ${evidence.length}`));
    }
    left.appendChild(meta);
    row.appendChild(left);
    const actions = el("div", { class: "actions" });
    const act = async (action) => {
      if (busy) return;
      busy = true;
      try {
        const payload = await api({ action, id: fact.id });
        facts = payload.facts || facts;
        render();
        say(`${action} ${fact.id}`);
      } catch (error) {
        say(String(error.message || error));
      } finally {
        busy = false;
      }
    };
    actions.appendChild(botonAcciones("hecho " + fact.id, () => {
      const out = [];
      if (status !== "confirmed") out.push({ label: "Confirmar", hint: "entra al prompt", run: () => {
        void act("confirm");
      } });
      out.push(fact.pinned ? { label: "Soltar", hint: "deja de ir al digest", run: () => {
        void act("unpin");
      } } : { label: "Fijar", hint: "siempre al digest", run: () => {
        void act("pin");
      } });
      if (status !== "rejected") out.push({ label: "Rechazar", hint: "el rastro queda", danger: true, run: () => {
        void act("reject");
      } });
      return out;
    }));
    row.appendChild(actions);
    mounted.list.appendChild(row);
  }
}
async function load() {
  try {
    const payload = await api();
    facts = payload.facts || [];
    render();
    say(payload.path ? `archivo: ${payload.path}` : "");
  } catch (error) {
    say(`no pude leer la memoria: ${String(error.message || error)}`);
  }
}
function openPanel() {
  ensureStyle();
  if (!mounted) {
    const built = buildPanel();
    mounted = built;
    document.body.appendChild(built.backdrop);
    built.filter.addEventListener("change", render);
    built.query.addEventListener("input", render);
    const add = async () => {
      const text = built.backdrop.querySelector(".toolbar input:last-of-type")?.value ?? "";
      const candidate = text.trim();
      if (!candidate) return;
      try {
        const payload = await api({ action: "add", text: candidate });
        facts = payload.facts || facts;
        const input = built.backdrop.querySelectorAll(".toolbar input")[1];
        if (input) input.value = "";
        render();
        say("hecho agregado y confirmado");
      } catch (error) {
        say(String(error.message || error));
      }
    };
    built.backdrop.querySelector(".toolbar button.primary").addEventListener("click", add);
    const inputs = built.backdrop.querySelectorAll(".toolbar input");
    inputs[1]?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void add();
    });
    built.backdrop.querySelector(".toolbar button:last-child").addEventListener("click", async () => {
      try {
        const payload = await api({ action: "consolidate" });
        facts = payload.facts || facts;
        render();
      } catch (error) {
        say(String(error.message || error));
      }
    });
    built.backdrop.querySelector("header button:first-of-type").addEventListener("click", () => {
      void load();
    });
  }
  mounted.backdrop.style.display = "flex";
  void load();
}
function closePanel() {
  if (mounted) mounted.backdrop.style.display = "none";
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePanel();
  if (event.altKey && event.ctrlKey && (event.key === "m" || event.key === "M")) {
    event.preventDefault();
    openPanel();
  }
});
window.__aegisMemory = { open: openPanel, close: closePanel, load: () => void load() };
