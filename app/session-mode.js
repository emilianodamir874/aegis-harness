const STORAGE_KEY = "aegis.sessionMode";
const ORDER = ["plan", "ejecutar", "revisar"];
const LABEL = {
  plan: "plan",
  ejecutar: "ejecutar",
  revisar: "revisar"
};
const HINT = {
  plan: "Plan: no puede escribir. Las tools de escritura no se le mandan al modelo.",
  ejecutar: "Ejecutar: permission.yaml manda, como siempre.",
  revisar: "Revisar: cada escritura pide permiso y muestra el diff."
};
const WRITE_TOOLS = ["shell", "edit", "write"];
const READ_ONLY_TOOLS = [
  "read_file",
  "grep",
  "tree",
  "read_image",
  "websearch__web_fetch",
  "websearch__web_search",
  "load_skill",
  "load",
  "chatrecall__chatrecall",
  "extensionmanager__search_available_extensions"
];
const CSS = `
.aegis-mode{margin-left:8px;padding:1px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);color:inherit;font:11.5px/1.7 system-ui,Segoe UI,sans-serif;cursor:pointer;text-transform:lowercase;letter-spacing:.2px}
.aegis-mode:hover{background:rgba(255,255,255,.12)}
.aegis-mode[data-mode=plan]{border-color:rgba(147,162,184,.5);color:#c8d3e2}
.aegis-mode[data-mode=revisar]{border-color:rgba(251,191,36,.55);color:#fbbf24}
.aegis-mode[data-mode=ejecutar]{border-color:rgba(74,222,128,.45);color:#4ade80}
`;
let chip = null;
let appliedFor = "";
function readMode() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "plan" || raw === "ejecutar" || raw === "revisar") return raw;
  } catch {
  }
  return "ejecutar";
}
function writeMode(mode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
  }
}
function entriesFor(mode) {
  if (mode === "ejecutar") return [];
  const permission = mode === "plan" ? "never_allow" : "ask_before";
  return WRITE_TOOLS.map((toolName) => ({ toolName, permission })).concat(
    READ_ONLY_TOOLS.map((toolName) => ({ toolName, permission: "always_allow" }))
  );
}
function sessionId() {
  const state = window.__aegisWeb?.state;
  return state?.current?.id || "";
}
async function apply() {
  const rpc = window.__aegisWeb?.rpc;
  const sid = sessionId();
  if (!rpc || !sid) return;
  const mode = readMode();
  try {
    await rpc.request("_aegis/unstable/tools/permissions/set", {
      toolPermissions: entriesFor(mode),
      sessionId: sid
    });
    appliedFor = `${sid}:${mode}`;
    if (chip) chip.title = `${HINT[mode]} Click para cambiar (plan → ejecutar → revisar).`;
  } catch (error) {
    if (chip) chip.title = `No pude aplicar el modo ${mode}: ${String(error.message || error)}`;
  }
}
function ensureChip() {
  if (chip && document.body.contains(chip)) return chip;
  const meta = document.querySelector(".composer-meta");
  if (!meta) return null;
  if (!document.getElementById("aegis-mode-style")) {
    const style = document.createElement("style");
    style.id = "aegis-mode-style";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  chip = document.createElement("button");
  chip.type = "button";
  chip.className = "aegis-mode";
  chip.addEventListener("click", () => {
    const next = ORDER[(ORDER.indexOf(readMode()) + 1) % ORDER.length];
    void set(next);
  });
  meta.appendChild(chip);
  return chip;
}
function renderChip() {
  if (chip) {
    chip.remove();
    chip = null;
  }
}
async function set(mode) {
  writeMode(mode);
  renderChip();
  await apply();
}
function tick() {
  renderChip();
}
window.addEventListener("aegis:mode-hint", (event) => {
  const detalle = event.detail;
  const modo = detalle?.mode;
  if (modo === "plan" || modo === "ejecutar" || modo === "revisar") {
    writeMode(modo);
    renderChip();
    appliedFor = `${sessionId()}:${modo}`;
  }
});
setInterval(tick, 1500);
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", tick);
} else {
  tick();
}
window.__aegisSessionMode = { apply, current: readMode, set };
