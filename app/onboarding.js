const CSS = `
.aegis-onboard{margin:26px auto 0;max-width:560px;text-align:left;border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:14px 16px;background:rgba(255,255,255,.02)}
.aegis-onboard h3{margin:0 0 10px;font-size:12.5px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:#93a2b8}
.aegis-onboard dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0;font-size:13px}
.aegis-onboard dt{color:#93a2b8}
.aegis-onboard dd{margin:0;color:inherit}
.aegis-onboard .sug{margin-top:12px;display:flex;flex-direction:column;gap:6px}
.aegis-onboard .sug button{text-align:left;cursor:pointer;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:7px 10px;color:inherit;font:inherit}
.aegis-onboard .sug button:hover{background:rgba(255,255,255,.11)}
`;
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== void 0) node.textContent = text;
  return node;
}
function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(Math.round(n));
}
async function getJson(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
function composerInput() {
  return document.querySelector(".composer textarea");
}
function fillComposer(text) {
  const input = composerInput();
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}
async function collect() {
  const rows = [];
  const usage = window.__aegisWeb?.usageState?.() || null;
  const model = usage && typeof usage.model === "string" ? usage.model : "";
  if (model) rows.push(["modelo", model]);
  const prices = await getJson("/prices.json");
  if (prices && model) {
    for (const [key, row] of Object.entries(prices)) {
      if (key.startsWith("_")) continue;
      if (!key.endsWith("/" + model)) continue;
      const input = typeof row.input === "number" ? `$${row.input.toFixed(2)}` : "?";
      const output = typeof row.output === "number" ? `$${row.output.toFixed(2)}` : "?";
      rows.push(["tarifa", `entrada ${input} / salida ${output} por 1M tok (estimada del store, no factura)`]);
      break;
    }
  }
  const limit = usage && typeof usage.limit === "number" ? usage.limit : 0;
  if (limit) rows.push(["contexto", `${fmtTok(limit)} tok · compacta sola al 80 %`]);
  const rpc = window.__aegisWeb?.rpc;
  if (rpc) {
    try {
      const tools = await rpc.request("tools/list", {});
      const names = (tools?.tools || []).map((tool) => String(tool.name || "")).filter(Boolean);
      if (names.length) {
        const escritura = ["write", "edit", "shell"].filter((n) => names.some((name) => name.endsWith(n)));
        rows.push(["tools", `${names.length} disponibles · escritura: ${escritura.join(", ") || "ninguna"}`]);
      }
    } catch {
    }
  }
  const goals = await getJson("/goals.json");
  const recent = (goals?.items || []).slice(0, 3).map((g) => String(g.text || g.title || "").trim()).filter(Boolean);
  if (recent.length) rows.push(["objetivos", recent.join(" · ")]);
  return rows;
}
function suggestions(rows) {
  const model = rows.find(([k]) => k === "modelo")?.[1] || "";
  const out = [];
  out.push("¿En qué está trabajando este proyecto? Leé el README, el AGENTS y los últimos commits, y resumí el estado en cinco líneas.");
  if (model) out.push(`Corré la suite de evaluación del harness y decime si hay regresiones desde la última corrida.`);
  out.push("Revisá los últimos errores de los logs y proponé el arreglo más barato, con el archivo y la línea.");
  return out.slice(0, 3);
}
async function refresh() {
  const welcome = document.getElementById("welcome");
  if (!welcome || welcome.hidden || welcome.offsetParent === null) return;
  if (!document.getElementById("aegis-onb-style")) {
    const style = el("style");
    style.id = "aegis-onb-style";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const rows = await collect();
  if (!rows.length) return;
  let card = document.getElementById("aegis-onboard");
  if (card) card.remove();
  card = el("div", "aegis-onboard");
  card.id = "aegis-onboard";
  card.appendChild(el("h3", void 0, "Con qué estás hablando"));
  const dl = el("dl");
  for (const [term, value] of rows) {
    dl.appendChild(el("dt", void 0, term));
    dl.appendChild(el("dd", void 0, value));
  }
  card.appendChild(dl);
  const sug = el("div", "sug");
  for (const text of suggestions(rows)) {
    const button = el("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", () => fillComposer(text));
    sug.appendChild(button);
  }
  card.appendChild(sug);
  const meta = document.getElementById("welcome-meta");
  if (meta && meta.parentElement) meta.parentElement.insertBefore(card, meta.nextSibling);
  else welcome.appendChild(card);
}
let last = 0;
function tick() {
  const now = Date.now();
  if (now - last < 4e3) return;
  last = now;
  void refresh();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", tick);
} else {
  tick();
}
setInterval(tick, 4e3);
window.__aegisWelcome = { refresh: () => void refresh() };
