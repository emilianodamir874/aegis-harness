const STATUS_LABEL = {
  confirmed: "confirmado",
  candidate: "candidato",
  rejected: "rechazado",
  stale: "archivado"
};
const STATUS_BADGE = {
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
const CSS = `
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
let mounted = null;
let facts = [];
let busy = false;
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
    if (status !== "confirmed") {
      actions.appendChild(el("button", { title: "Entra al prompt desde el proximo turno" }, "Confirmar")).addEventListener("click", () => act("confirm"));
    }
    if (fact.pinned) {
      actions.appendChild(el("button", { title: "Dejar de fijarlo" }, "Soltar")).addEventListener("click", () => act("unpin"));
    } else {
      actions.appendChild(el("button", { title: "Va siempre al digest" }, "Fijar")).addEventListener("click", () => act("pin"));
    }
    if (status !== "rejected") {
      actions.appendChild(el("button", { title: "Deja de entrar al digest; el rastro queda" }, "Rechazar")).addEventListener("click", () => act("reject"));
    }
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
