const SECRET_PATTERNS = [/sk-[A-Za-z0-9_\-]{12,}/, /ghp_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /xox[baprs]-[A-Za-z0-9\-]{10,}/, /Bearer\s+[A-Za-z0-9._\-]{20,}/];
const CSS = `
.aegis-ho-backdrop{position:fixed;inset:0;background:rgba(6,8,12,.6);backdrop-filter:blur(2px);z-index:9350;display:flex;align-items:center;justify-content:center;padding:20px}
.aegis-ho{width:min(820px,100%);max-height:88vh;display:flex;flex-direction:column;background:var(--panel,#14181f);color:var(--fg,#e7edf5);border:1px solid rgba(255,255,255,.1);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.55);font:14px/1.45 system-ui,Segoe UI,sans-serif;overflow:hidden}
.aegis-ho header{display:flex;gap:10px;align-items:center;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.08)}
.aegis-ho header h2{margin:0;font-size:15px;font-weight:650}
.aegis-ho header .grow{flex:1}
.aegis-ho select,.aegis-ho textarea{font:inherit;color:inherit;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.12);border-radius:8px}
.aegis-ho .body{padding:12px 16px;display:flex;flex-direction:column;gap:10px;overflow:auto}
.aegis-ho textarea{min-height:230px;padding:10px;resize:vertical;font:12.5px/1.5 ui-monospace,Consolas,monospace}
.aegis-ho button{cursor:pointer;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 11px;color:inherit;font:inherit}
.aegis-ho button:hover{background:rgba(255,255,255,.13)}
.aegis-ho button.primary{background:#2f6df6;border-color:#2f6df6;color:#fff}
.aegis-ho .foot{display:flex;gap:8px;padding:10px 16px;border-top:1px solid rgba(255,255,255,.08);align-items:center}
.aegis-ho .status{color:#93a2b8;font-size:12px;margin-left:auto}
`;
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== void 0) node.textContent = text;
  return node;
}
function hasSecret(line) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(line));
}
function clip(text, max) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}
function buildHandoff(title, transcript) {
  const lines = transcript.split("\n").map((line) => line.trim()).filter(Boolean);
  const sinSecretos = lines.filter((line) => !hasSecret(line));
  const objetivo = sinSecretos.find((line) => line.startsWith(">") && line.length > 20) || sinSecretos.find((line) => /^(#|##)\s/.test(line) === false && line.length > 40) || "";
  const decisiones = sinSecretos.filter((line) => /\b(decid|eleg|conviene|arregl|qued[oó]|commit|merge)/i.test(line)).slice(-8).map((line) => "- " + clip(line, 240));
  const pendientes = sinSecretos.filter((line) => /\b(falta|pendiente|todo|pr[oó]xim|queda por|sin resolver|romp)/i.test(line)).slice(-8).map((line) => "- " + clip(line, 240));
  const estado = sinSecretos.slice(-6).map((line) => clip(line, 200)).join(" ");
  const parts = [`## Handoff · ${title || "sesión anterior"}`, ""];
  parts.push("### Objetivo");
  parts.push(objetivo ? clip(objetivo.replace(/^>\s*/, ""), 600) : "(no detectado: completalo a mano)");
  parts.push("", "### Estado");
  parts.push(estado ? clip(estado, 900) : "(no detectado)");
  if (decisiones.length) {
    parts.push("", "### Decisiones");
    parts.push(...decisiones);
  }
  if (pendientes.length) {
    parts.push("", "### Próximos pasos");
    parts.push(...pendientes);
  }
  parts.push("", "_Generado desde el transcript de la sesión origen. Revisar antes de enviar._");
  return parts.join("\n");
}
let backdrop = null;
let statusEl = null;
function rpc() {
  return window.__aegisWeb?.rpc;
}
function say(text) {
  if (statusEl) statusEl.textContent = text;
}
function fillComposer(text) {
  const input = document.querySelector(".composer textarea");
  if (!input) {
    say("no encontré el composer");
    return;
  }
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}
async function listSessions() {
  const client = rpc();
  if (!client) return [];
  try {
    const res = await client.request("session/list", {});
    return res?.sessions || [];
  } catch {
    return [];
  }
}
async function exportSession(sessionId) {
  const client = rpc();
  if (!client) return "";
  try {
    const res = await client.request(
      "_aegis/unstable/session/export",
      { sessionId, format: "markdown" }
    );
    return String(res?.data || res?.markdown || res?.text || "");
  } catch (error) {
    say(`no pude exportar: ${String(error.message || error)}`);
    return "";
  }
}
async function open() {
  if (backdrop) return;
  if (!document.getElementById("aegis-ho-style")) {
    const style = el("style");
    style.id = "aegis-ho-style";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  backdrop = el("div", "aegis-ho-backdrop");
  const box = el("div", "aegis-ho");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Pasar contexto de otra sesión");
  const header = el("header");
  header.appendChild(el("h2", void 0, "Pasar contexto a esta sesión"));
  header.appendChild(el("span", "grow"));
  const closeBtn = el("button", void 0, "Cerrar");
  closeBtn.addEventListener("click", close);
  header.appendChild(closeBtn);
  box.appendChild(header);
  const body = el("div", "body");
  const select = el("select");
  select.appendChild(el("option", void 0, "Cargando sesiones…"));
  body.appendChild(select);
  const area = el("textarea");
  area.placeholder = "Elegí una sesión origen para generar el bloque";
  body.appendChild(area);
  box.appendChild(body);
  const foot = el("div", "foot");
  const gen = el("button", void 0, "Generar");
  const copy = el("button", void 0, "Copiar");
  const insert = el("button", "primary", "Insertar en el composer");
  statusEl = el("div", "status");
  foot.append(gen, copy, insert, statusEl);
  box.appendChild(foot);
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
  const sessions = await listSessions();
  select.textContent = "";
  const activa = String(window.__aegisWeb?.state?.current?.id || "");
  const candidatas = sessions.filter((row) => String(row.sessionId || row.id) !== activa);
  if (!candidatas.length) {
    select.appendChild(el("option", void 0, "no hay otras sesiones"));
    say("sin sesiones de origen");
    return;
  }
  for (const row of candidatas.slice(0, 60)) {
    const id = String(row.sessionId || row.id || "");
    const option = el("option", void 0, `${row.title || row.name || id.slice(0, 8)} · ${String(row.updatedAt || "").slice(0, 10)}`);
    option.value = id;
    select.appendChild(option);
  }
  const generar = async () => {
    const id = select.value;
    if (!id) return;
    say("leyendo el transcript…");
    const text = await exportSession(id);
    if (!text) {
      say("el export vino vacío");
      return;
    }
    const titulo = select.options[select.selectedIndex]?.textContent || "";
    area.value = buildHandoff(titulo, text);
    say(`${text.length} chars leídos · bloque listo para revisar`);
  };
  gen.addEventListener("click", () => void generar());
  select.addEventListener("change", () => void generar());
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(area.value);
      say("copiado");
    } catch {
      say("el navegador no dejó copiar: seleccioná y Ctrl+C");
    }
  });
  insert.addEventListener("click", () => {
    if (!area.value.trim()) return;
    fillComposer(area.value);
    say("insertado en el composer (todavía sin enviar)");
  });
  void generar();
}
function close() {
  if (!backdrop) return;
  backdrop.remove();
  backdrop = null;
  statusEl = null;
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") close();
  if (event.altKey && event.ctrlKey && (event.key === "h" || event.key === "H")) {
    event.preventDefault();
    void open();
  }
});
window.__aegisHandoff = { open: () => void open(), close };
