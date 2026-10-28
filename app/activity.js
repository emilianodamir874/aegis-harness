const MAX_PAGES = 8;
const MAX_DETAILS = 30;
let detailReads = 0;
const CSS = `
.aegis-activity-backdrop{position:fixed;inset:0;z-index:9150;background:rgba(6,8,12,.65);display:flex;align-items:center;justify-content:center;padding:16px}
.aegis-activity{width:min(850px,100%);max-height:min(90dvh,900px);display:flex;flex-direction:column;overflow:hidden;background:var(--panel,#14181f);color:var(--fg,#e7edf5);border:1px solid rgba(255,255,255,.15);border-radius:12px;font:14px/1.45 system-ui,Segoe UI,sans-serif}
.aegis-activity header{display:flex;gap:10px;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.15)}
.aegis-activity header h2{font-size:17px;margin:0;flex:1}
.aegis-activity button{font:inherit;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:5px 10px;cursor:pointer}
.aegis-activity main{overflow:auto;padding:12px 16px;min-height:0}
.aegis-activity h3{font-size:14px;margin:16px 0 6px}
.aegis-activity .cwd{overflow-wrap:anywhere;color:#b2c5d9}
.aegis-activity .row{display:block;width:100%;text-align:left;margin:4px 0;padding:7px 10px;border-radius:6px;background:rgba(255,255,255,.045);overflow-wrap:anywhere}
.aegis-activity button.row:hover{background:rgba(255,255,255,.13)}
.aegis-activity .secondary,.aegis-activity .note{color:#b2c5d9;font-size:12px}
.aegis-activity .timeline{margin:4px 0;padding-left:22px}
.aegis-activity .timeline li{margin:4px 0;overflow-wrap:anywhere}
.aegis-activity .note{padding:8px 16px;border-top:1px solid rgba(255,255,255,.12)}
`;
let backdrop = null;
let main = null;
let note = null;
let serial = 0;
function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== void 0) node.textContent = text;
  return node;
}
function web() {
  return window.__aegisWeb;
}
function appendMessage(parent, text) {
  parent.append(el("p", text, "secondary"));
}
const SAFE_TOOLS = /* @__PURE__ */ new Set([
  "shell",
  "read_file",
  "write",
  "edit",
  "grep",
  "tree",
  "read_image",
  "web_search",
  "web_fetch",
  "load_skill",
  "load",
  "summon",
  "final_output",
  "parallel"
]);
function safeToolName(name) {
  const short = name.slice(name.lastIndexOf(".") + 1);
  return SAFE_TOOLS.has(short) ? short : "herramienta";
}
function summarizeExport(raw, id) {
  const session = raw;
  if (!session || session.id !== id || !Array.isArray(session.conversation)) return { summary: ["Detalle: no registrado"], timeline: [] };
  const requests = /* @__PURE__ */ new Map();
  const responded = /* @__PURE__ */ new Set();
  let calls = 0, ok = 0, failed = 0, subagents = 0;
  for (const message of session.conversation) {
    if (message?.metadata?.userVisible === false || !Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "toolRequest" || typeof block.id !== "string" || !block.id || requests.has(block.id)) continue;
      const name = block.toolCall?.status === "success" ? block.toolCall.value?.name : void 0;
      if (typeof name !== "string") continue;
      calls++;
      requests.set(block.id, { id: block.id, name: safeToolName(name), outcome: "unknown" });
      if (name === "summon" || name.endsWith(".summon")) subagents++;
    }
  }
  for (const message of session.conversation) {
    if (message?.metadata?.userVisible === false || !Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "toolResponse" || typeof block.id !== "string") continue;
      const request = requests.get(block.id);
      if (!request || request.outcome !== "unknown" || responded.has(block.id)) continue;
      responded.add(block.id);
      if (block.toolResult?.status === "error" || block.toolResult?.value?.isError === true) {
        failed++;
        request.outcome = "failure";
      } else if (block.toolResult?.status === "success" && block.toolResult?.value?.isError === false) {
        ok++;
        request.outcome = "success";
      }
    }
  }
  return {
    summary: [
      `Herramientas: ${calls} llamadas; ${ok} resultados correctos explícitos; ${failed} errores explícitos; ${calls - ok - failed} sin resultado registrado`,
      `Subagentes (llamadas explícitas summon): ${subagents || "no registrado"}`,
      "Tests: no registrado (el export no tiene campo estructurado de tests)."
    ],
    timeline: [...requests.values()].slice(-12).reverse()
  };
}
async function showDetails(id, target, generation) {
  target.replaceChildren(el("p", "Leyendo export JSON…", "secondary"));
  try {
    const client = web()?.rpc;
    if (!client?.ready) throw new Error("ACP no conectado");
    const response = await client.request("_aegis/unstable/session/export", { sessionId: id, format: "json" });
    const details = typeof response?.data === "string" ? summarizeExport(JSON.parse(response.data), id) : { summary: ["Detalle: no registrado"], timeline: [] };
    if (generation !== serial || !target.isConnected) return;
    target.replaceChildren(...details.summary.map((line) => el("p", line, "secondary")));
    if (!details.timeline.length) return;
    target.append(el("h3", "Últimas herramientas (export; resultados explícitos)"));
    const list = el("ol", void 0, "timeline");
    for (const tool of details.timeline) {
      const item = el("li");
      const label = `${tool.name} · ${tool.id} · ${tool.outcome === "success" ? "éxito explícito" : tool.outcome === "failure" ? "fallo explícito" : "resultado desconocido"}`;
      if (typeof web()?.openTool === "function") {
        const link = el("button", label);
        link.type = "button";
        link.addEventListener("click", async () => {
          try {
            if (await web()?.openTool?.(id, tool.id)) close();
          } catch {
          }
        });
        item.append(link);
      } else item.textContent = label;
      list.append(item);
    }
    target.append(list);
  } catch {
    if (generation === serial && target.isConnected) target.replaceChildren(el("p", "Detalle: no registrado (export no disponible)", "secondary"));
  }
}
async function refresh() {
  const current = ++serial;
  detailReads = 0;
  if (!main || !note) return;
  const view = main;
  const status = note;
  view.replaceChildren(el("p", "Consultando sesiones y confirmaciones…"));
  status.textContent = "Foto solicitada manualmente · solo lectura";
  const client = web()?.rpc;
  const pendingPromise = fetch("/pending.json", { cache: "no-store" }).then(async (response) => {
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  });
  const sessionsPromise = (async () => {
    if (!client?.ready) throw new Error("ACP no conectado");
    const rows = [];
    const running = /* @__PURE__ */ new Set();
    const seen = /* @__PURE__ */ new Set();
    let cursor = null;
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await client.request("session/list", {
        cursor: cursor || void 0,
        meta: { aegis: { includeLastMessageSnippet: false } }
      });
      if (!Array.isArray(response?.sessions)) throw new Error("session/list no devolvió sesiones");
      for (const row of response.sessions) if (row && typeof row.sessionId === "string" && row.sessionId) rows.push(row);
      if (Array.isArray(response._meta?.runningSessionIds)) {
        for (const id of response._meta.runningSessionIds) if (typeof id === "string") running.add(id);
      }
      const next = response.nextCursor;
      if (!next) break;
      if (typeof next !== "string" || seen.has(next)) throw new Error("cursor de sesiones inválido o repetido");
      seen.add(next);
      cursor = next;
      if (page === MAX_PAGES - 1) truncated = true;
    }
    const confirmed = /* @__PURE__ */ new Map();
    const listedIds = new Set(rows.map((row) => row.sessionId));
    const marked = [...running].filter((id) => listedIds.has(id));
    for (let start = 0; start < marked.length; start += 6) {
      await Promise.all(marked.slice(start, start + 6).map(async (id) => {
        try {
          const info = await client.request(
            "_aegis/unstable/session/info",
            { sessionId: id }
          );
          const run = info?.session?._meta?.activeRunId;
          confirmed.set(id, run === void 0 ? "unknown" : run ? "yes" : "no");
        } catch {
          confirmed.set(id, "unknown");
        }
      }));
    }
    return { rows, running, confirmed, truncated };
  })();
  const [listed, pending] = await Promise.allSettled([sessionsPromise, pendingPromise]);
  if (current !== serial || view !== main) return;
  view.replaceChildren();
  const heading = el("h3", "Sesiones por directorio");
  view.append(heading);
  if (listed.status === "rejected") {
    appendMessage(view, "No se pudieron consultar sesiones: " + String(listed.reason?.message || listed.reason));
  } else {
    const { rows, running, confirmed, truncated } = listed.value;
    const groups = /* @__PURE__ */ new Map();
    const unique = /* @__PURE__ */ new Set();
    for (const row of rows) {
      if (unique.has(row.sessionId)) continue;
      unique.add(row.sessionId);
      const cwd = typeof row.cwd === "string" && row.cwd ? row.cwd : "Directorio no informado";
      if (!groups.has(cwd)) groups.set(cwd, []);
      groups.get(cwd).push(row);
    }
    if (!groups.size) appendMessage(view, "No hay sesiones en las páginas consultadas.");
    for (const [cwd, entries] of groups) {
      const section = el("section");
      section.append(el("h3", cwd + " · " + entries.length, "cwd"));
      for (const row of entries) {
        const nav = Array.from(document.querySelectorAll(".sb-row[data-id]")).find((item2) => item2.dataset.id === row.sessionId)?.querySelector("button.sb-item");
        const item = nav ? el("button", void 0, "row") : el("div", void 0, "row");
        if (nav) {
          item.setAttribute("type", "button");
          item.addEventListener("click", () => {
            nav.click();
            close();
          });
        }
        item.append(el("span", typeof row.title === "string" && row.title ? row.title : row.sessionId));
        const signal = !running.has(row.sessionId) ? "Estado de trabajo no informado" : confirmed.get(row.sessionId) === "yes" ? "Trabajando (listado e info)" : confirmed.get(row.sessionId) === "no" ? "Listado marcó trabajo; info no lo confirma" : "Trabajando según listado (info no disponible)";
        item.append(el("div", row.sessionId + " · " + signal + (nav ? "" : " · no está en el sidebar; sin navegación disponible"), "secondary"));
        section.append(item);
        const expand = el("button", "Ver detalle", "secondary");
        expand.type = "button";
        const detail = el("div");
        expand.addEventListener("click", () => {
          if (detail.childNodes.length) {
            detail.replaceChildren();
            expand.textContent = "Ver detalle";
            return;
          }
          if (detailReads >= MAX_DETAILS) {
            detail.textContent = "Límite de detalles por recarga alcanzado.";
            return;
          }
          detailReads++;
          expand.textContent = "Ocultar detalle";
          void showDetails(row.sessionId, detail, current);
        });
        section.append(expand, detail);
      }
      view.append(section);
    }
    status.textContent = `${unique.size} sesiones · ${groups.size} directorios · ${truncated ? `límite de ${MAX_PAGES} páginas alcanzado; lista incompleta` : "páginas agotadas"} · foto ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}`;
  }
  view.append(el("h3", "Confirmaciones sin respuesta registrada"));
  if (pending.status === "rejected" || pending.value.error) {
    appendMessage(view, "No se pudo consultar /pending.json: " + (pending.status === "rejected" ? String(pending.reason?.message || pending.reason) : pending.value.error));
  } else if (!Array.isArray(pending.value.sessions)) {
    appendMessage(view, "Formato de confirmaciones no disponible.");
  } else if (!pending.value.sessions.length) {
    appendMessage(view, "Ninguna confirmación sin respuesta registrada.");
  } else {
    for (const item of pending.value.sessions) {
      if (typeof item?.sessionId !== "string") continue;
      view.append(el("div", `${item.sessionId} · ${Number(item.pendientes) || 1} sin respuesta registrada`, "row"));
    }
  }
}
function close() {
  serial++;
  backdrop?.remove();
  backdrop = null;
  main = null;
  note = null;
}
async function open() {
  if (backdrop) {
    await refresh();
    return;
  }
  if (!document.getElementById("aegis-activity-style")) {
    const style = el("style", CSS);
    style.id = "aegis-activity-style";
    document.head.append(style);
  }
  backdrop = el("div", void 0, "aegis-activity-backdrop");
  const dialog = el("div", void 0, "aegis-activity");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Actividad de solo lectura");
  const header = el("header");
  header.append(el("h2", "Actividad"));
  const reload = el("button", "Recargar");
  reload.type = "button";
  reload.addEventListener("click", () => void refresh());
  const dismiss = el("button", "Cerrar");
  dismiss.type = "button";
  dismiss.addEventListener("click", close);
  header.append(reload, dismiss);
  main = el("main");
  note = el("div", "Foto en solo lectura · no permite aprobar confirmaciones", "note");
  dialog.append(header, main, note);
  backdrop.append(dialog);
  document.body.append(backdrop);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  dismiss.focus();
  await refresh();
}
async function toggle() {
  if (backdrop) close();
  else await open();
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && backdrop) close();
});
window.__aegisActivity = { open, close, toggle, refresh };
