// src/app/format.ts
var esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var fmtTok = (n) => {
  if (n == null) return "–";
  if (n < 1e3) return String(n);
  if (n < 1e6) return (Math.round(n / 100) / 10).toString().replace(/\.0$/, "") + "k";
  return (Math.round(n / 104857.6) / 10).toString().replace(/\.0$/, "") + "M";
};
var fmtCost = (c) => {
  if (c == null) return "";
  if (c === 0) return "$0";
  const s = c < 0.01 ? c.toFixed(5) : c.toFixed(4);
  return "$" + s.replace(/0+$/, "").replace(/\.$/, "");
};
var fmtSize = (n) => {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return Math.round(n / 102.4) / 10 + " KB";
  return Math.round(n / 104857.6) / 10 + " MB";
};
var fmtTps = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + " tok/s";
function stepRate(u) {
  const output = u?.outputTokens;
  if (typeof output !== "number" || !Number.isFinite(output) || output <= 0) return null;
  const generation = u?.generationMs;
  const hasGeneration = typeof generation === "number" && Number.isFinite(generation) && generation > 0;
  const durationMs = hasGeneration ? generation : u?.elapsedMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return { value: output / (durationMs / 1e3), kind: hasGeneration ? "generation" : "request", durationMs };
}
var COMPACT_RATIO = 0.8;
function compactTrig(st) {
  if (!st) return { at: null, pct: null, estimated: true };
  if (st.autoCompactAt != null) {
    return {
      at: st.autoCompactAt,
      pct: st.autoCompactPct != null ? st.autoCompactPct * 100 : st.limit ? st.autoCompactAt / st.limit * 100 : null,
      estimated: false
    };
  }
  if (st.limit) return { at: st.limit * COMPACT_RATIO, pct: COMPACT_RATIO * 100, estimated: true };
  return { at: null, pct: null, estimated: true };
}
var sameDay = (a, b) => a.toDateString() === b.toDateString();
var dayLabel = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Más antiguas";
  const now = /* @__PURE__ */ new Date();
  if (sameDay(d, now)) return "Hoy";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Ayer";
  if (now.getTime() - d.getTime() < 7 * 864e5) return "Esta semana";
  if (now.getTime() - d.getTime() < 31 * 864e5) return "Este mes";
  return "Más antiguas";
};
var fmtTime = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = /* @__PURE__ */ new Date();
  if (sameDay(d, now)) return d.toTimeString().slice(0, 5);
  return d.getDate() + "/" + (d.getMonth() + 1);
};

// src/app/icons.ts
var TOOL_ICON = {
  shell: '<path d="M4.6 5.4 7.2 8l-2.6 2.6M9.4 11h3.2"/>',
  read: '<path d="M4 2.8h4.6L12 6.2v7H4z"/><path d="M8.4 2.8v3.4H12"/><path d="M6 9.6h4"/>',
  write: '<path d="M3 13.2l.9-2.9 6-6 2 2-6 6z"/><path d="M9.4 4.9l2 2"/>',
  image: '<rect x="2.6" y="3.4" width="10.8" height="9.2" rx="1.6"/><path d="M2.6 10.2 5.6 7.4l2.2 2.2 1.8-1.8 3 2.8"/>',
  search: '<circle cx="7.4" cy="7.4" r="3.8"/><path d="M10.2 10.2 13.4 13.4"/>',
  glob: '<circle cx="8" cy="8" r="5.2"/><path d="M2.8 8h10.4M8 2.8c1.6 1.6 1.6 8.8 0 10.4M8 2.8c-1.6 1.6-1.6 8.8 0 10.4"/>',
  code: '<path d="M5.6 5.4 3 8l2.6 2.6M10.4 5.4 13 8l-2.6 2.6"/>',
  cross: '<path d="M4.8 4.8l6.4 6.4M11.2 4.8l-6.4 6.4"/>',
  dot: '<circle cx="8" cy="8" r="2.6"/>'
};
function toolIconSvg(kind, status) {
  if (status === "failed") kind = "cross";
  const name = String(kind || "").toLowerCase().replace(/[_-]/g, " ").trim();
  if (!TOOL_ICON[kind]) {
    kind = /shell|terminal|bash|powershell|exec|cmd/.test(name) ? "shell" : /image|screenshot|vision|photo/.test(name) ? "image" : /search|grep|find|glob|recall/.test(name) ? "search" : /write|edit|create|patch|save|apply/.test(name) ? "write" : /read|file|cat|open|list|tree|view/.test(name) ? "read" : /fetch|http|web|browse|url|curl/.test(name) ? "glob" : /code|script|typescript|eval|run|test/.test(name) ? "code" : "dot";
  }
  return '<svg class="tico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + TOOL_ICON[kind] + "</svg>";
}

// src/app/markdown.ts
var inline = (t) => {
  let s = esc(t);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(
    /\[([^\]\n]+)\]\(\/dl\/([A-Za-z0-9._-]{1,120})\)/g,
    (_match, label, name) => `<a class="dl-chip" href="/dl/${name}" download="${name}"><span class="dl-ico" aria-hidden="true">↓</span><span>${label}</span></a>`
  );
  s = s.replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
};
var isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l);
var splitRow = (l) => {
  let s = String(l).trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
};
var alignsOf = (sep) => splitRow(sep).map((c) => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "");
var tableHtml = (head, aligns, rows) => {
  const plain = (s) => String(s == null ? "" : s).replace(/[*`_]/g, "").trim();
  const cell = (tag, txt, i, label) => {
    const a = aligns[i];
    return `<${tag}${a ? ` style="text-align:${a}"` : ""}${label ? ` data-label="${esc(label)}"` : ""}>${inline(txt)}</${tag}>`;
  };
  return '<div class="tbl-wrap"><table' + (head.length === 2 ? ' data-cols="2"' : "") + "><thead><tr>" + head.map((c, i) => cell("th", c, i)).join("") + "</tr></thead>" + (rows.length ? "<tbody>" + rows.map((r) => "<tr>" + head.map((_, i) => cell("td", r[i] == null ? "" : r[i], i, plain(head[i]))).join("") + "</tr>").join("") + "</tbody>" : "") + "</table></div>";
};
var mdBlocks = (t) => {
  const lines = t.split(/\r?\n/);
  let out = "";
  let para = [];
  let list = [];
  let listType = null;
  const flushPara = () => {
    if (para.length) {
      out += `<p>${para.join("<br>")}</p>`;
      para = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out += `<${listType}>${list.map((x) => `<li>${x}</li>`).join("")}</${listType}>`;
      listType = null;
      list = [];
    }
  };
  for (let _i = 0; _i < lines.length; _i++) {
    const line = lines[_i];
    if (line.includes("|") && _i + 1 < lines.length && isTableSep(lines[_i + 1])) {
      flushPara();
      flushList();
      const head = splitRow(line);
      const aligns = alignsOf(lines[_i + 1]);
      const rows = [];
      let j = _i + 2;
      while (j < lines.length && lines[j].includes("|") && !/^\s*$/.test(lines[j])) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      out += tableHtml(head, aligns, rows);
      _i = j - 1;
      continue;
    }
    const mH = /^(#{1,5})\s+(.*)$/.exec(line);
    const mUl = /^\s*[-*•]\s+(.*)$/.exec(line);
    const mOl = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const mQ = /^>\s?(.*)$/.exec(line);
    const mHr = /^\s*([-*_])\1{2,}\s*$/.test(line);
    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      continue;
    }
    if (mHr) {
      flushPara();
      flushList();
      out += "<hr>";
      continue;
    }
    if (mH) {
      flushPara();
      flushList();
      const lvl = Math.min(mH[1].length + 2, 5);
      out += `<h${lvl}>${inline(mH[2])}</h${lvl}>`;
      continue;
    }
    if (mUl) {
      flushPara();
      if (listType !== "ul") {
        flushList();
        listType = "ul";
      }
      list.push(inline(mUl[1]));
      continue;
    }
    if (mOl) {
      flushPara();
      if (listType !== "ol") {
        flushList();
        listType = "ol";
      }
      list.push(inline(mOl[1]));
      continue;
    }
    if (mQ) {
      flushPara();
      flushList();
      out += `<blockquote>${inline(mQ[1])}</blockquote>`;
      continue;
    }
    flushList();
    para.push(inline(line));
  }
  flushPara();
  flushList();
  return out;
};
var md = (text) => {
  const parts = String(text ?? "").split("```");
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const body = parts[i].replace(/^[a-zA-Z0-9+#_.-]* ?\r?\n/, "").replace(/\r?\n$/, "");
      html += `<div class="code-wrap"><button class="copy-code" type="button">Copiar</button><pre><code>${esc(body)}</code></pre></div>`;
    } else {
      const joinedDownloads = parts[i].replace(/\[([^\]\r\n]+)\]\s*\r?\n\s*\((\/dl\/[A-Za-z0-9._-]{1,120})\)/g, "[$1]($2)");
      html += mdBlocks(joinedDownloads);
    }
  }
  return html;
};

// src/app/sessions.ts
function sessionRow(s, o) {
  const meta = s._meta || {};
  const n = meta.messageCount;
  const sub = `${n != null ? n + " · " : ""}${fmtTime(s.updatedAt || meta.createdAt)}`;
  const active = o.active ? " active" : "";
  const arch = o.archived;
  return `<div class="sb-row" data-id="${esc(s.sessionId)}"${arch ? ' data-arch="1"' : ""}><button class="sb-item${active}${arch ? " arch" : ""}"><div class="sb-title">${o.running ? '<span class="sb-run-dot" title="en produccion ahora">&#9679;</span>' : ""}${o.done ? '<span class="sb-done-dot" title="termino hace un momento">&#10004;</span>' : ""}${esc(s.title || "Sesión")}${arch ? '<span class="sb-tag">archivada</span>' : ""}</div><div class="sb-sub">${sub}</div></button><button class="sb-rename" title="Renombrar" aria-label="Renombrar">✎</button><button class="sb-more" title="Más acciones" aria-label="Más acciones">⋮</button><button class="sb-del" title="Borrar sesión" aria-label="Borrar sesión">✕</button></div>`;
}
var updatedAt = (s) => s.updatedAt || s._meta && s._meta.createdAt || "";
var ts = (s) => Date.parse(updatedAt(s)) || 0;
function sessionListHtml(st) {
  const q = st.filter.trim().toLowerCase();
  const match = (s) => !q || String(s.title || "").toLowerCase().includes(q);
  const items = st.sessions.filter(match).sort((a, b) => ts(b) - ts(a));
  const arch = st.archived.filter(match).sort((a, b) => ts(b) - ts(a));
  if (!items.length && !arch.length) {
    return `<div class="sb-empty">${st.sessions.length || st.archived.length ? "Sin resultados" : "Sin sesiones todavía"}</div>`;
  }
  const row = (s, archived) => sessionRow(s, {
    archived,
    active: st.activeId === s.sessionId,
    running: st.isRunning(s.sessionId),
    done: !st.isRunning(s.sessionId) && st.isDoneRecently(s.sessionId)
  });
  let html = "";
  let lastGroup = null;
  for (const s of items) {
    const group = dayLabel(updatedAt(s));
    if (group !== lastGroup) {
      html += `<div class="sb-group">${group}</div>`;
      lastGroup = group;
    }
    html += row(s, false);
  }
  if (st.cursor) {
    const more = st.pages > 1 ? `Cargar más (${st.pages} páginas)` : "Cargar más sesiones";
    html += `<button class="sb-more-btn" type="button">${more}</button>`;
  }
  if (arch.length || st.archived.length) {
    if (st.showArchived) {
      html += `<div class="sb-group">Archivadas</div>`;
      html += arch.length ? arch.map((s) => row(s, true)).join("") : `<div class="sb-empty">Ninguna coincide con la búsqueda.</div>`;
      html += `<button class="sb-arch-toggle open" type="button"><span class="caret">▶</span> Ocultar archivadas</button>`;
    } else {
      html += `<button class="sb-arch-toggle" type="button"><span class="caret">▶</span> Ver archivadas (${st.archived.length})</button>`;
    }
  }
  return html;
}

// src/app/read.ts
var TICK = String.fromCharCode(96);
function readHeading(t) {
  const re = /^[ \t]*#{1,6}[ \t]*(?:[^\w\n]{0,4}[ \t]*)?(?:para[ \t]+(?:escuchar|leer|oir|oír)|lectura[ \t]+en[ \t]+voz)[^\n]*$/im;
  const m = re.exec(String(t || ""));
  return m ? { idx: m.index, len: m[0].length } : null;
}
function readBlock(t) {
  const h = readHeading(t);
  if (!h) return "";
  const rest = String(t).slice(h.idx + h.len);
  const end = rest.search(/^[ \t]*#{1,6}[ \t]/m);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}
function readClean(s) {
  return String(s || "").replace(new RegExp(TICK + TICK + TICK + "[\\s\\S]*?" + TICK + TICK + TICK, "g"), " ").replace(new RegExp(TICK + "([^" + TICK + "]*)" + TICK, "g"), "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "").replace(/^[ \t]*>[ \t]?/gm, "").replace(/[#*_~|]/g, "").replace(/\s+/g, " ").trim();
}
function ttsUrlFor(voice, text) {
  return "/tts?voice=" + encodeURIComponent(voice) + "&text=" + encodeURIComponent(text);
}

// src/app.ts
(() => {
  "use strict";
  const CFG = window.__AEGIS_APP__ || {};
  const $ = (s) => document.querySelector(s);
  const report = (kind, msg, extra) => {
    try {
      fetch("/client-log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, msg: String(msg).slice(0, 4e3), url: location.href, ua: navigator.userAgent, ...extra })
      }).catch(() => {
      });
    } catch {
    }
  };
  window.addEventListener("error", (e) => report("error", (e.message || "") + " @ " + (e.filename || "") + ":" + (e.lineno || "")));
  window.addEventListener("unhandledrejection", (e) => report("rejection", String(e.reason && e.reason.message || e.reason)));
  const greeting = () => {
    const h = (/* @__PURE__ */ new Date()).getHours();
    return h >= 6 && h < 12 ? "Buenos días" : h >= 12 && h < 20 ? "Buenas tardes" : "Buenas noches";
  };
  const copyText = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  };
  const state = {
    sessions: [],
    archived: [],
    current: null,
    msgs: /* @__PURE__ */ new Map(),
    tools: /* @__PURE__ */ new Map(),
    seq: 0,
    busy: false,
    filter: "",
    booted: false,
    attachments: [],
    permCard: null,
    // {id, el}
    hold: null,
    // 'rename' | 'confirm' — pausa re-renders mientras hay UI inline abierta
    runId: null,
    // id del run activo del server (para steering)
    adopted: false,
    resyncing: false,
    suppressSettle: false,
    // true si el turno en curso lo arrancó otra conexión (o sobrevivió a un reload)
    steers: /* @__PURE__ */ new Map(),
    // messageId -> burbuja local del steer encolado
    queue: [],
    // mensajes escritos mientras el agente trabaja y no hay run al que apuntar
    slash: [],
    // comandos disponibles (notification available_commands_update / RPC)
    slashLoaded: false,
    slashLoading: false,
    slashItems: [],
    slashIdx: 0,
    replaying: false,
    // true mientras se reproduce un historial (evita autoscroll por chunk)
    pages: 1,
    // páginas de session/list ya traídas
    cursor: null,
    showArchived: false,
    welcomeMode: "new",
    // ---------- v6.4: watch por sesión (hub con fan-out) ----------
    hubWatch: void 0,
    // true = el server implementa _aegis/unstable/session/watch; false = v2/v3
    hubCursor: null,
    // último cursor del hub para la sesión en pantalla (re-watch al reconectar)
    hubWatchSid: null,
    // sesión a la que está enganchada esta conexión
    hubWatchers: null,
    // watcherCount que reportó el server (hint de UI)
    hubReplay: false
    // true mientras se aplica el replay de un watch
  };
  const rpc = {
    ws: null,
    nextId: 1,
    pending: /* @__PURE__ */ new Map(),
    backoff: 1e3,
    ready: false,
    retrying: null,
    connect() {
      clearTimeout(this.retrying);
      setStatus("warn", "Conectando…");
      let ws;
      try {
        ws = new WebSocket(CFG.acpUrl);
      } catch (e) {
        report("error", "WS ctor: " + e.message);
        setStatus("err", "Sin conexión");
        return;
      }
      this.ws = ws;
      ws.onopen = async () => {
        try {
          await this.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { _meta: { aegis: { customNotifications: true, toolCallLabelEnrichment: true } } },
            clientInfo: { name: "aegis-web", version: "1.3" },
            _meta: { "aegis/useLoginShellPath": true }
          });
          const wasReady = this.ready;
          this.ready = true;
          this.backoff = 1e3;
          setStatus("ok", "Conectado");
          if (!state.booted) {
            state.booted = true;
            onBoot();
          } else if (!wasReady) {
            refreshSessions();
            finishStream();
            if (state.hubWatch === true) await hubRewatch();
            else if (state.busy) setBusy(false, "Se cortó la conexión: el turno se interrumpió");
            flushQueue();
          }
          if (state.hubWatch !== true) checkAdoptedRun();
        } catch (e) {
          report("error", "initialize: " + e.message);
          try {
            ws.close();
          } catch {
          }
        }
      };
      ws.onmessage = (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          report("error", "mensaje ilegible");
          return;
        }
        if (m.id !== void 0 && m.method === void 0) {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            if (m.error) {
              const err = new Error(m.error && m.error.message || "error RPC");
              err.code = m.error.code;
              err.data = m.error.data;
              p.rej(err);
            } else p.res(m.result);
          }
          return;
        }
        if (m.method) handleServerMessage(m);
      };
      ws.onclose = () => {
        this.ready = false;
        state.suppressSettle = true;
        state.hubWatchSid = null;
        const pend = [...this.pending.values()];
        this.pending.clear();
        for (const p of pend) {
          try {
            p.rej(new Error("conexión cerrada"));
          } catch {
          }
        }
        if (state.booted) setStatus("warn", "Reconectando…");
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, 15e3);
        this.retrying = setTimeout(() => this.connect(), delay);
      };
      ws.onerror = () => {
      };
    },
    request(method, params) {
      return new Promise((res, rej) => {
        const id = this.nextId++;
        this.pending.set(id, {
          res,
          rej: (err) => {
            const m = err && err.message ? err.message : String(err);
            const ya = m.indexOf("[metodo: ") >= 0;
            if (err && typeof err === "object") {
              err.message = ya ? m : m + " [metodo: " + method + "]";
              rej(err);
            } else rej(new Error(ya ? m : m + " [metodo: " + method + "]"));
          }
        });
        try {
          this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        } catch (e) {
          this.pending.delete(id);
          rej(e);
        }
      });
    },
    notify(method, params) {
      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
      } catch {
      }
    },
    respond(id, result) {
      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch {
      }
    }
  };
  let titleLock = null;
  function handleServerMessage(m) {
    if (m.method === "session/update") return onUpdate(m.params || {});
    if (m.method === "_aegis/unstable/session/update") return onAegisUpdate(m.params || {});
    if (m.method === "session/request_permission") return showPermCard(m);
    if (m.method === "_aegis/unstable/session/replay_gap") return onReplayGap(m.params || {});
    if (m.id !== void 0) {
      try {
        rpc.ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no soportado: " + m.method } }));
      } catch {
      }
    }
  }
  function onUpdate(params) {
    if (state.replayBuf && params.sessionId === state.current?.id) {
      state.replayBuf.push(params);
      return;
    }
    applyUpdate(params);
  }
  function applyUpdate(params) {
    const cur = state.current;
    if (!cur || params.sessionId !== cur.id) return;
    const u = params.update || {};
    switch (u.sessionUpdate) {
      case "user_message_chunk": {
        const mid = u.messageId;
        if (mid && state.steers.has(mid)) {
          markSteerDelivered(mid);
          break;
        }
        if (mid && userBubbleOnScreen(mid)) {
          if (u.content && u.content.type === "image") adjuntarImagenA(mid, u.content);
          noteResume(cur.id, mid);
          break;
        }
        if (mid && u.content && (u.content.type === "text" && adoptLocalEcho(mid, u.content.text) || u.content.type === "image" && adoptLocalImage(mid, u.content))) {
          noteResume(cur.id, mid);
          break;
        }
        const fromMid = hiddenFromId(cur.id);
        if (mid && fromMid) {
          if (mid === fromMid) state.hideTail = true;
          else if (mid === resumeMid(cur.id)) state.hideTail = false;
          else noteResume(cur.id, mid);
        }
        const ag = u._meta && u._meta.aegis;
        const oculto = ag ? ag.agentVisible !== true : state.hideTail;
        if (u.content && u.content.type === "text") addUser(u.content.text, true, null, { mid, hidden: oculto });
        else if (u.content && u.content.type === "image") addUser("", true, [u.content], { mid, hidden: oculto });
        if (oculto) markHiddenTail();
        break;
      }
      case "agent_message_chunk":
        if (u.content && u.content.type === "text") {
          chunksTurn++;
          textoDelTurno += u.content.text;
          streamAppend(u.messageId || "a", u.content.text, false, u._meta && u._meta.aegis ? u._meta.aegis.agentVisible !== true : state.hideTail);
          speedChunk(u.content.text, u.messageId);
        }
        break;
      case "agent_thought_chunk":
        if (u.content && u.content.type === "text") {
          speedStep(u.messageId, true);
          streamAppend(thoughtKeyFor(u), u.content.text, true, u._meta && u._meta.aegis ? u._meta.aegis.agentVisible !== true : state.hideTail);
        }
        break;
      case "tool_call":
      case "tool_call_update":
        speedStep(u.messageId, true);
        toolUpsert(u);
        break;
      case "usage_update":
        setUsage(u);
        break;
      case "message_usage":
        setMsgUsage(u);
        break;
      case "available_commands_update":
        if (Array.isArray(u.availableCommands)) {
          state.slash = u.availableCommands;
          state.slashLoaded = true;
          refreshSlashMenu();
        }
        break;
      case "session_info_update": {
        const g = u._meta && u._meta.aegis || {};
        if (g.activeRunId !== void 0) applyActiveRunId(g.activeRunId || null);
        if (g.queuedSteer && state.steers.has(g.queuedSteer.messageId)) {
          state.steers.get(g.queuedSteer.messageId).serverQueued = true;
          setQueuedNote(state.steers.get(g.queuedSteer.messageId), "indicación encolada en el server…");
        }
        const locked = titleLock && titleLock.id === cur.id && Date.now() < titleLock.until;
        if (u.title && !locked) {
          cur.title = u.title;
          updateTitle();
        }
        if (Array.isArray(u.configOptions)) {
          cur.configOptions = u.configOptions;
          renderChips();
        }
        if (u.modes) cur.modes = u.modes;
        break;
      }
      default:
        break;
    }
  }
  function onAegisUpdate(params) {
    const cur = state.current;
    if (!cur) return;
    const u = params.update || {};
    const g = params.aegis || u._meta && u._meta.aegis || params._meta && params._meta.aegis;
    if (g && g.activeRunId !== void 0 && (!params.sessionId || params.sessionId === cur.id)) applyActiveRunId(g.activeRunId || null);
    if (params.sessionId !== cur.id) return;
    if (u.sessionUpdate === "usage_update") setUsage(u);
    if (u.sessionUpdate === "message_usage") setMsgUsage(u);
    if (u.sessionUpdate === "status_message" && u.status && u.status.type === "progress" && u.status.message) {
      setPill(u.status.message);
    }
  }
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!rpc.ready) return;
    if (!anyRunning() && Date.now() - lastListPoll < 2e4) return;
    lastListPoll = Date.now();
    refreshSessions().catch(() => {
    });
  }, 4e3);
  function renderList() {
    if (state.hold) return;
    const list = $("#session-list");
    if (!list) return;
    list.innerHTML = sessionListHtml({
      sessions: state.sessions,
      archived: state.archived,
      filter: state.filter,
      cursor: state.cursor,
      pages: state.pages,
      showArchived: state.showArchived,
      activeId: state.current && state.current.id || null,
      isRunning,
      isDoneRecently
    });
  }
  function toast(msg, kind) {
    const t = document.createElement("div");
    t.className = "toast" + (kind ? " " + kind : "");
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 250);
    }, kind === "err" ? 4200 : 2600);
  }
  const closeRowMenus = () => document.querySelectorAll("body > .menu.row-menu").forEach((m) => m.remove());
  function openRowMenu(btn, id, archived) {
    closeMenus();
    closeRowMenus();
    const menu = document.createElement("div");
    menu.className = "menu row-menu";
    const entry = (label, fn) => {
      const b = document.createElement("button");
      b.className = "menu-row";
      b.type = "button";
      b.innerHTML = `<span>${label}</span>`;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.remove();
        fn();
      });
      menu.appendChild(b);
    };
    entry("Copiar ID de sesión", () => copySessionId(id));
    entry("Renombrar", () => startRename(id));
    entry("Exportar como Markdown", () => exportSession(id, "markdown"));
    entry("Exportar como JSON", () => exportSession(id, "json"));
    if (archived) entry("Desarchivar", () => unarchiveSession(id));
    else entry("Archivar", () => archiveSession(id));
    document.body.appendChild(menu);
    openMenu(btn, menu);
  }
  const findSession = (id) => state.sessions.find((s) => s.sessionId === id) || state.archived.find((s) => s.sessionId === id);
  async function archiveSession(id) {
    try {
      await rpc.request("_aegis/unstable/session/archive", { sessionId: id });
    } catch (e) {
      toast("No se pudo archivar: " + e.message, "err");
      return;
    }
    const s = state.sessions.find((x) => x.sessionId === id);
    state.sessions = state.sessions.filter((x) => x.sessionId !== id);
    if (s) {
      s._meta = { ...s._meta || {}, archivedAt: (/* @__PURE__ */ new Date()).toISOString() };
      state.archived = [s, ...state.archived.filter((x) => x.sessionId !== id)];
    }
    if (!state.archived.length) refreshSessions();
    else {
      state.showArchived = true;
      renderList();
    }
    toast("Sesión archivada — está en «Archivadas».");
  }
  async function unarchiveSession(id) {
    try {
      await rpc.request("_aegis/unstable/session/unarchive", { sessionId: id });
    } catch (e) {
      toast("No se pudo desarchivar: " + e.message, "err");
      return;
    }
    const s = state.archived.find((x) => x.sessionId === id);
    state.archived = state.archived.filter((x) => x.sessionId !== id);
    if (s) {
      delete (s._meta || {}).archivedAt;
      state.sessions = [s, ...state.sessions.filter((x) => x.sessionId !== id)];
    }
    renderList();
    toast("Sesión desarchivada.");
  }
  function downloadFile(name, mime, text) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 6e3);
      return true;
    } catch {
      return false;
    }
  }
  async function exportSession(id, format) {
    const entry = findSession(id);
    const base = (entry && entry.title || id).replace(/[^\w\-. áéíóúÁÉÍÓÚñÑ]+/g, "_").trim().slice(0, 60).replace(/^[.\s]+/, "") || id;
    const ext = format === "markdown" ? "md" : "json";
    let data = "";
    try {
      const res = await rpc.request("_aegis/unstable/session/export", { sessionId: id, format });
      data = res && res.data || "";
    } catch (e) {
      toast("No se pudo exportar: " + e.message, "err");
      return;
    }
    if (!data) {
      toast("La exportación vino vacía.", "err");
      return;
    }
    const ok = downloadFile(`${base}.${ext}`, format === "markdown" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8", data);
    if (ok) toast(`Exportada «${base}.${ext}» (${fmtSize(data.length)}).`);
    else {
      const copied = await copyText(data);
      toast(copied ? "Descarga bloqueada: la exportación quedó en el portapapeles." : "No se pudo exportar en este navegador.", copied ? "" : "err");
    }
  }
  function markActive(id) {
    document.querySelectorAll(".sb-item").forEach((el) => el.classList.toggle("active", el.parentElement.dataset.id === id));
  }
  let sessionListGeneration = 0;
  async function refreshSessions() {
    const pages = Math.max(1, state.pages);
    const all = [];
    let cursor = null;
    const running = /* @__PURE__ */ new Set();
    const generation = ++sessionListGeneration;
    try {
      for (let i = 0; i < pages; i++) {
        const res = await rpc.request("session/list", {
          cursor: cursor || void 0,
          meta: { aegis: { includeLastMessageSnippet: false } }
        });
        all.push(...res && res.sessions || []);
        const rmeta = res && (res._meta || res.meta) || {};
        for (const id of rmeta.runningSessionIds || []) running.add(String(id));
        cursor = res && res.nextCursor || null;
        if (!cursor) break;
      }
      if (generation !== sessionListGeneration) return;
      const previous = state.runningIds || /* @__PURE__ */ new Set();
      state.runningIds = running;
      state.sessions = all.filter((s) => !(s._meta && s._meta.archivedAt));
      state.archived = all.filter((s) => s._meta && s._meta.archivedAt);
      state.cursor = cursor;
      for (const id of previous) if (!running.has(id)) markRun(id, false);
      for (const id of running) if (!previous.has(id)) markRun(id, true);
      renderList();
    } catch (e) {
      report("error", "session/list: " + e.message);
    }
  }
  async function copySessionId(id) {
    const texto = String(id || "");
    if (!texto) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(texto);
      ok = true;
    } catch (e) {
    }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = texto;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, texto.length);
        ok = document.execCommand("copy");
        ta.remove();
      } catch (e) {
      }
    }
    systemNote(ok ? "ID de sesión copiado: " + texto : "No pude copiar solo; el ID es: " + texto);
    return ok;
  }
  async function loadMoreSessions() {
    const btn = document.querySelector(".sb-more-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Cargando…";
    }
    state.pages += 1;
    await refreshSessions();
  }
  function askDelete(id) {
    const row = document.querySelector(`.sb-row[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const body = row.querySelector(".sb-item");
    if (row.querySelector(".sb-confirm")) return;
    state.hold = "confirm";
    body.style.display = "none";
    const c = document.createElement("div");
    c.className = "sb-confirm";
    c.innerHTML = '<span>¿Borrar sesión?</span><button class="ym">Sí</button><button class="nn">No</button>';
    row.appendChild(c);
    c.querySelector(".nn").addEventListener("click", (e) => {
      e.stopPropagation();
      state.hold = null;
      renderList();
    });
    c.querySelector(".ym").addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await rpc.request("session/delete", { sessionId: id });
      } catch (err) {
        systemNote("No se pudo borrar: " + err.message);
        state.hold = null;
        renderList();
        return;
      }
      state.sessions = state.sessions.filter((s) => s.sessionId !== id);
      if (state.current && state.current.id === id) {
        state.current = null;
        state.msgs.clear();
        state.tools.clear();
        updateTitle();
        renderChips();
      }
      if (!state.current) {
        clearMessages();
        showWelcome("new");
      }
      state.hold = null;
      renderList();
    });
  }
  function startRename(id) {
    const row = document.querySelector(`.sb-row[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const titleEl = row.querySelector(".sb-title");
    const entry = state.sessions.find((s) => s.sessionId === id);
    const input = document.createElement("input");
    input.className = "sb-edit";
    input.value = entry && entry.title || titleEl.textContent || "";
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    state.hold = "rename";
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (save && title) {
        let ok = false;
        try {
          await rpc.request("_aegis/unstable/session/rename", { sessionId: id, title });
          ok = true;
        } catch (e) {
          systemNote("No se pudo renombrar: " + e.message);
        }
        if (ok) {
          const fresh = state.sessions.find((s) => s.sessionId === id);
          if (fresh) fresh.title = title;
          titleLock = { id, title, until: Date.now() + 15e3 };
          if (state.current && state.current.id === id) {
            state.current.title = title;
            updateTitle();
          }
        }
      }
      state.hold = null;
      renderList();
      if (save && title) refreshSessions();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());
  }
  function msgWrap() {
    if (state.offscreen) return state.offscreen;
    let w = $("#msg-inner");
    if (!w) {
      hideWelcome();
      w = document.createElement("div");
      w.id = "msg-inner";
      w.className = "msg-inner";
      $("#messages").appendChild(w);
    }
    return w;
  }
  (function wireRecortes() {
    const RE = /…?\s*\[recortado: \d+ bytes omitidos del replay\]/;
    const marcar = (raiz) => {
      const caja = document.getElementById("messages");
      if (!caja || !raiz) return;
      const objetivos = [];
      if (raiz.nodeType === 1) {
        if (raiz === caja || caja.contains(raiz)) objetivos.push(raiz);
        if (raiz.querySelectorAll) objetivos.push(...raiz.querySelectorAll("*"));
      }
      if (raiz === caja) objetivos.splice(0, Math.max(0, objetivos.length - 400));
      const textos = /* @__PURE__ */ new Set();
      for (const o of objetivos) {
        if (!o.textContent || o.textContent.indexOf("[recortado:") === -1) continue;
        if (o.closest && o.closest(".replay-cut")) continue;
        const w = document.createTreeWalker(o, NodeFilter.SHOW_TEXT);
        let t;
        while (t = w.nextNode()) textos.add(t);
      }
      {
        for (const tn of textos) {
          if (!tn.parentNode) continue;
          const m = RE.exec(tn.nodeValue || "");
          if (!m) continue;
          const span = document.createElement("span");
          span.className = "replay-cut";
          span.textContent = m[0].trim();
          span.title = "El servidor no reenvía bloques de más de 8 KB al reabrir el chat, así que esta parte no viajó. El mensaje guardado está completo.";
          const antes = tn.nodeValue.slice(0, m.index);
          const despues = tn.nodeValue.slice(m.index + m[0].length);
          const frag = document.createDocumentFragment();
          if (antes.trim()) frag.appendChild(document.createTextNode(antes.trim() + " "));
          frag.appendChild(span);
          if (despues.trim()) frag.appendChild(document.createTextNode(" " + despues.trim()));
          tn.parentNode.replaceChild(frag, tn);
        }
      }
    };
    const arrancar = () => {
      marcar(document);
      const caja = document.getElementById("messages");
      if (!caja) return;
      new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) marcar(n);
      }).observe(caja, { childList: true, subtree: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arrancar, { once: true });
    else arrancar();
  })();
  function pintaModeloPorDefecto() {
    const el = document.getElementById("default-model-chip");
    if (!el) return;
    const hayChat = !!(state.current && state.current.id);
    const modelo = String(CFG && CFG.defaultModel || "");
    const hayChips = document.querySelectorAll("#chips .chip").length > 0;
    if (hayChat || !modelo || hayChips) {
      if (!el.hidden) {
        el.hidden = true;
        el.textContent = "";
      }
      return;
    }
    if (el.hidden || el.textContent !== modelo) {
      el.hidden = false;
      el.textContent = modelo;
      el.title = "Modelo por defecto de los chats nuevos (lo define el servidor). Al abrir un chat se cambia con los selectores de la barra.";
    }
  }
  (function wireModeloPorDefecto() {
    const arrancar = () => {
      state.pendingConfig = leerPendientes();
      pintaModeloPorDefecto();
      setInterval(pintaModeloPorDefecto, 3e3);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arrancar, { once: true });
    else arrancar();
  })();
  function showWelcome(mode, title) {
    const w = $("#welcome");
    if (!w) return;
    state.welcomeMode = mode || "new";
    const h1 = $("#welcome-h1");
    const sub = w.querySelector(".welcome-sub");
    if (state.welcomeMode === "empty") {
      if (h1) h1.textContent = "Sesión sin mensajes";
      if (sub) sub.textContent = (title ? `«${title}» ` : "Esta sesión ") + "todavía no tiene mensajes. Escribí abajo para arrancar la conversación.";
    } else {
      if (h1) h1.textContent = greeting();
      if (sub) sub.textContent = "Aegis está listo. Puede leer y editar archivos de esta máquina, correr comandos y buscar en la web.";
    }
    w.hidden = false;
  }
  const hideWelcome = () => {
    $("#welcome")?.setAttribute("hidden", "");
  };
  const scrollBottom = (force) => {
    if (state.replaying) return;
    const m = $("#messages");
    if (force || state.pinUntil > performance.now() || m.scrollHeight - m.scrollTop - m.clientHeight < 140) m.scrollTop = m.scrollHeight;
  };
  function goalFromText(text) {
    const s = String(text == null ? "" : text).trim();
    const m = s.match(/^\/(goal|grind)(?:\s+([\s\S]*))?$/i);
    if (!m) return null;
    const kind = m[1].toLowerCase();
    const params = String(m[2] || "").trim();
    if (!params) return { action: "none", kind };
    if (/^(off|clear|none)$/i.test(params)) return { action: "clear", kind };
    return { action: "set", kind, goal: params };
  }
  function noteGoalFrom(text) {
    const r = goalFromText(text);
    if (!r) return;
    if (r.action === "set") {
      state.goal = r.goal;
      state.grind = r.kind === "grind" ? r.goal : null;
    } else if (r.action === "clear") {
      state.goal = null;
      state.grind = null;
    }
    renderGoalBar();
    if (r.action !== "none") fetchGoals(true);
  }
  function renderGoalBar() {
    const bar = document.getElementById("goalbar");
    if (!bar) return;
    const g = state.goal;
    if (!g) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    bar.innerHTML = "";
    const tag = document.createElement("span");
    tag.className = "goalbar-tag";
    tag.textContent = state.grind ? "Objetivo (a fondo)" : "Objetivo";
    const txt = document.createElement("span");
    txt.className = "goalbar-text";
    txt.textContent = g;
    txt.title = g;
    const x = document.createElement("button");
    x.type = "button";
    x.id = "goalbar-x";
    x.className = "goalbar-x";
    x.textContent = "×";
    x.title = "Quitar el objetivo (/goal off)";
    x.setAttribute("aria-label", "Quitar el objetivo");
    x.addEventListener("click", () => {
      sendText("/goal off");
    });
    bar.append(tag, txt, x);
  }
  function addRewindBtn(el) {
    if (!el || el.querySelector(".rewind-btn")) return;
    const rw = document.createElement("button");
    rw.type = "button";
    rw.className = "rewind-btn";
    rw.title = "Rebobinar a este mensaje (el modelo deja de ver de aca en adelante)";
    rw.setAttribute("aria-label", "Rebobinar a este mensaje");
    rw.textContent = "↺";
    el.appendChild(rw);
  }
  function identifyUserBubble(el, mid) {
    if (!el || !el.isConnected || !mid || el.dataset.mid && el.dataset.mid !== mid) return false;
    el.dataset.mid = mid;
    if (!el.classList.contains("queued")) addRewindBtn(el);
    return true;
  }
  function adjuntarImagenA(mid, content) {
    if (!content || !content.data || !content.mimeType) return false;
    const el = document.querySelector('.msg-user[data-mid="' + (window.CSS && CSS.escape ? CSS.escape(mid) : mid) + '"]');
    if (!el) return false;
    if (el.querySelector('img[data-dl-img="1"]')) return true;
    const img = document.createElement("img");
    img.dataset.dlImg = "1";
    img.src = "data:" + content.mimeType + ";base64," + content.data;
    img.alt = "adjunto";
    el.appendChild(img);
    return true;
  }
  function addUser(text, replay, atts, opts) {
    noteGoalFrom(text);
    if (SOFT.on && replay && !(opts && opts.local)) {
      SOFT.users.push({ text, atts, mid: opts && opts.mid || "", hidden: !!(opts && opts.hidden) });
      softPush("user", SOFT.users.length - 1);
      return null;
    }
    hideWelcome();
    const el = document.createElement("div");
    el.className = "msg-user" + (opts && opts.queued ? " queued" : "") + (opts && opts.hidden ? " hidden-from-agent" : "");
    if (!replay) el.classList.add("in");
    if (opts && opts.mid) el.dataset.mid = opts.mid;
    let html = text ? md(text) : "";
    for (const a of atts || []) {
      if (a && a.kind === "text") html += `<div class="att-note">📄 ${esc(a.name)}</div>`;
      else if (a && a.data && a.mimeType) html += `<img src="data:${esc(a.mimeType)};base64,${a.data}" alt="${esc(a.name || "adjunto")}">`;
    }
    el.innerHTML = html;
    if (opts && opts.mid && !opts.queued) addRewindBtn(el);
    msgWrap().appendChild(el);
    scrollBottom(replay);
    return el;
  }
  const aegisMeta = (u) => u && u._meta && u._meta.aegis || {};
  function hiddenFromKey(sid) {
    return "aegis.hiddenFrom." + sid;
  }
  function hiddenFromId(sid) {
    try {
      return localStorage.getItem(hiddenFromKey(sid)) || "";
    } catch {
      return "";
    }
  }
  function setHiddenFrom(sid, mid) {
    if (!sid || !mid) return;
    try {
      localStorage.setItem(hiddenFromKey(sid), mid);
    } catch {
    }
  }
  function clearHiddenFrom(sid) {
    if (!sid) return;
    try {
      localStorage.removeItem(hiddenFromKey(sid));
    } catch {
    }
    state.hideTail = false;
  }
  function isHiddenMid(sid, mid) {
    const from = hiddenFromId(sid);
    return !!(from && mid && from === mid);
  }
  function resumeMid(sid) {
    try {
      return localStorage.getItem("aegis.resume." + sid) || "";
    } catch {
      return "";
    }
  }
  function noteResume(sid, mid) {
    if (!sid || !mid) return;
    const from = hiddenFromId(sid);
    if (from && mid !== from && !resumeMid(sid) && !state.replaying) setResume(sid, mid);
  }
  function setResume(sid, mid) {
    if (!sid) return;
    try {
      mid ? localStorage.setItem("aegis.resume." + sid, mid) : localStorage.removeItem("aegis.resume." + sid);
    } catch {
    }
  }
  function markHiddenTail() {
    const inner = $("#msg-inner");
    if (!inner) return;
    for (const m of inner.querySelectorAll(".rw-marker")) m.remove();
    const kids = [...inner.children];
    const first = kids.findIndex((k) => k.classList.contains("hidden-from-agent"));
    if (first < 0) {
      for (const k of kids) k.classList.remove("hidden-tail", "rw-boundary");
      return;
    }
    let last = first;
    for (let i = kids.length - 1; i >= first; i--) {
      if (kids[i].classList.contains("hidden-from-agent")) {
        last = i;
        break;
      }
    }
    const ocultos = kids.slice(first, last + 1);
    const marker = document.createElement("div");
    marker.className = "rw-marker";
    marker.textContent = "Rebobinado: " + ocultos.length + (ocultos.length === 1 ? " mensaje oculto" : " mensajes ocultos") + " (el modelo no los ve; siguen guardados en la sesion)";
    inner.insertBefore(marker, kids[first]);
    for (const k of ocultos) k.remove();
  }
  function askRewind(el) {
    if (!el || el.querySelector(".rw-confirm")) return;
    if (state.busy) {
      toast("Espera a que termine el turno para rebobinar.", "err");
      return;
    }
    const c = document.createElement("div");
    c.className = "rw-confirm";
    c.innerHTML = '<span>Rebobinar aca?</span><button class="ym" type="button">Si</button><button class="nn" type="button">No</button>';
    el.appendChild(c);
    c.querySelector(".nn").addEventListener("click", (e) => {
      e.stopPropagation();
      c.remove();
    });
    c.querySelector(".ym").addEventListener("click", async (e) => {
      e.stopPropagation();
      c.remove();
      await rewindTo(el);
    });
  }
  async function rewindTo(el) {
    const mid = el && el.dataset.mid;
    const cur = state.current;
    if (!mid || !cur) return;
    try {
      const res = await rpc.request("_aegis/unstable/session/rewind", { sessionId: cur.id, messageId: mid });
      setHiddenFrom(cur.id, mid);
      setResume(cur.id, "");
      const inner = $("#msg-inner");
      if (inner) {
        let seen = false;
        for (const k of inner.children) {
          if (k === el) seen = true;
          if (seen) k.classList.add("hidden-from-agent");
        }
      }
      markHiddenTail();
      if (res && res.text) {
        const input = document.getElementById("input");
        if (input) {
          input.value = res.text;
          autosize();
          refreshSlashMenu();
          input.focus();
        }
      }
      systemNote("Rebobinado: se ocultaron " + (res && res.hidden || 0) + " mensaje(s) desde aca (el modelo no los ve). El texto quedo en el composer para editarlo.");
    } catch (err) {
      toast("No se pudo rebobinar: " + (err && err.message || err), "err");
    }
  }
  async function regenerateLast() {
    const cur = state.current;
    if (!cur) return;
    if (state.busy) {
      toast("Espera a que termine el turno para regenerar.", "err");
      return;
    }
    try {
      const res = await rpc.request("_aegis/unstable/session/rewind", { sessionId: cur.id, back: 1 });
      if (!res || !res.text) {
        toast("No hay un turno para regenerar.", "err");
        return;
      }
      const inner = $("#msg-inner");
      const users = inner ? [...inner.querySelectorAll(":scope > .msg-user")] : [];
      const lastUser = users[users.length - 1];
      if (lastUser && lastUser.dataset.mid) setHiddenFrom(cur.id, lastUser.dataset.mid);
      setResume(cur.id, "");
      if (inner) {
        let seen = false;
        for (const k of inner.children) {
          if (k === lastUser) seen = true;
          if (seen) k.classList.add("hidden-from-agent");
        }
      }
      markHiddenTail();
      state.hideTail = false;
      await sendText(res.text);
      systemNote("Regenerando: la respuesta anterior quedo oculta para el modelo (sigue guardada en la sesion).");
    } catch (err) {
      toast("No se pudo regenerar: " + (err && err.message || err), "err");
    }
  }
  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest && e.target.closest(".rewind-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    askRewind(btn.closest(".msg-user"));
  });
  const setQueuedNote = (el, msg) => {
    if (el && el.el) el = el.el;
    if (!el) return;
    let n = el.querySelector(".steer-note");
    if (!n) {
      n = document.createElement("div");
      n.className = "steer-note";
      el.appendChild(n);
    }
    n.textContent = msg;
  };
  const METRICS = { renders: 0, renderMs: 0, maxRenderMs: 0, lastRenderMs: 0, composerRuns: 0, composerMs: 0, maxComposerMs: 0 };
  const SOFT = { on: false, text: /* @__PURE__ */ new Map(), kind: /* @__PURE__ */ new Map(), users: [], tools: /* @__PURE__ */ new Map(), order: [] };
  let lastTypedAt = 0;
  let lastSoftAt = 0;
  const SOFT_MIN_MS = 12e3;
  const SOFT_REFRESH_MS = 15e3;
  let softBackoffMs = SOFT_REFRESH_MS;
  const SOFT_QUIET_MS = 2500;
  const softReset = () => {
    SOFT.text.clear();
    SOFT.kind.clear();
    SOFT.tools.clear();
    SOFT.order = [];
    SOFT.users = [];
  };
  const softPush = (tipo, k) => {
    for (let i = SOFT.order.length - 1; i >= 0 && i > SOFT.order.length - 60; i--) {
      if (SOFT.order[i][0] === tipo && SOFT.order[i][1] === k) return;
    }
    SOFT.order.push([tipo, k]);
  };
  const dirty = /* @__PURE__ */ new Set();
  let rafId = 0;
  let renderTimer = 0;
  const STREAM_RENDER_MS = 90;
  const STREAM_RENDER_MS_TYPING = 260;
  const RENDER_BUDGET_MS = 12;
  const RENDER_MIN_PER_FRAME = 4;
  function flushRender() {
    rafId = 0;
    if (!dirty.size) return;
    const now = performance.now();
    const frameT0 = now;
    const measure = [];
    let wait = 0;
    let done = 0;
    for (const rec of [...dirty]) {
      const age = now - (rec.lastAppend || 0);
      const streamMs = performance.now() - lastTypedAt < 400 ? STREAM_RENDER_MS_TYPING : STREAM_RENDER_MS;
      if (rec.live && age < streamMs) {
        wait = Math.max(wait, streamMs - age);
        continue;
      }
      if (done >= RENDER_MIN_PER_FRAME && performance.now() - frameT0 >= RENDER_BUDGET_MS) break;
      done++;
      dirty.delete(rec);
      rec.dirty = false;
      const _t0 = performance.now();
      rec.body.innerHTML = md(rec.text);
      {
        const rd = rec.el.querySelector(".msg-read");
        if (rd) rd.hidden = !readBlock(rec.text);
      }
      const _dt = performance.now() - _t0;
      METRICS.renders++;
      METRICS.renderMs += _dt;
      METRICS.lastRenderMs = _dt;
      if (_dt > METRICS.maxRenderMs) METRICS.maxRenderMs = _dt;
      if (rec.body.classList.contains("thought")) measure.push(rec);
    }
    for (const rec of measure) rec.body.classList.toggle("short", rec.body.scrollHeight <= rec.body.clientHeight + 2);
    scrollBottom();
    if (dirty.size && !rafId && !renderTimer) {
      rafId = requestAnimationFrame(flushRender);
    }
    if (dirty.size && !renderTimer) {
      renderTimer = setTimeout(() => {
        renderTimer = 0;
        if (!rafId) rafId = requestAnimationFrame(flushRender);
      }, Math.max(24, Math.round(wait)));
    }
  }
  const drainRender = async (maxMs = 5e3) => {
    const t0 = performance.now();
    while (dirty.size && performance.now() - t0 < maxMs) await new Promise((r) => requestAnimationFrame(r));
  };
  const queueRender = (rec) => {
    if (rec.dirty) return;
    rec.dirty = true;
    dirty.add(rec);
    if (!rafId) rafId = requestAnimationFrame(flushRender);
  };
  let curStream = null;
  function clearStreaming() {
    if (curStream) {
      if (curStream.__rec) curStream.__rec.live = false;
      curStream.classList.remove("streaming");
      curStream = null;
    }
  }
  function closeAllRecs() {
    for (const r of new Set(state.msgs.values())) {
      r.closed = true;
      r.live = false;
    }
  }
  function finishStream() {
    clearStreaming();
    setPill(null);
  }
  function thoughtKeyFor(u) {
    const wrap = msgWrap();
    const prev = state.thoughtRec;
    if (prev && prev.el.parentElement === wrap && prev.el === wrap.lastElementChild) {
      return state.thoughtKey;
    }
    state.thoughtKey = "think:" + (u.messageId || "a") + ":" + Date.now().toString(36);
    state.thoughtRec = null;
    return state.thoughtKey;
  }
  function streamAppend(key, text, thought, hidden) {
    if (state.hubReplay) {
      HUB.text.set(key, (HUB.text.get(key) || "") + text);
      HUB.kind.set(key, !!thought);
      return;
    }
    if (SOFT.on) {
      SOFT.text.set(key, (SOFT.text.get(key) || "") + text);
      SOFT.kind.set(key, !!thought);
      softPush("text", key);
      return;
    }
    hideWelcome();
    noteRunActivity();
    let rec = state.msgs.get(key);
    if (rec && rec.text) {
      const prev = String(rec.text);
      const inc = String(text == null ? "" : text);
      if (inc && inc.length >= 12 && prev === inc) return;
      if (inc && inc.length > prev.length && inc.startsWith(prev)) {
        text = inc.slice(prev.length);
        if (!text) return;
      } else if (inc && inc.length >= 40 && prev.startsWith(inc)) return;
    }
    if (rec && rec.closed) {
      const w = msgWrap();
      if (thought && rec.el.parentElement === w && rec.el === w.lastElementChild) rec.closed = false;
      else rec = null;
    }
    if (!rec) {
      if (!thought) clearStreaming();
      const el = document.createElement("div");
      el.className = "msg-a" + (hidden ? " hidden-from-agent" : "");
      const body = document.createElement("div");
      body.className = thought ? "thought" : "content";
      el.appendChild(body);
      const cp = document.createElement("button");
      cp.className = "msg-copy";
      cp.type = "button";
      cp.textContent = "Copiar";
      el.appendChild(cp);
      if (!thought) {
        const rd = document.createElement("button");
        rd.className = "msg-read";
        rd.type = "button";
        rd.textContent = "🔊 Escuchar";
        rd.hidden = true;
        el.appendChild(rd);
      }
      msgWrap().appendChild(el);
      rec = { el, body, text: "", dirty: false, closed: false, live: false, lastAppend: 0 };
      el.__rec = rec;
      state.msgs.set(key, rec);
      if (thought) state.thoughtRec = rec;
      if (!thought) curStream = el;
    }
    rec.text += text;
    if (!thought && !hidden && !state.replaying) readPump(key, rec.text);
    rec.lastAppend = performance.now();
    rec.live = !state.replaying;
    queueRender(rec);
    if (!thought && rec.el !== curStream) {
      clearStreaming();
      curStream = rec.el;
    }
    if (!state.replaying) {
      rec.el.classList.add("in");
      if (!thought) rec.el.classList.add("streaming");
    }
    scrollBottom();
  }
  function toolUpsert(u, quiet) {
    if (SOFT.on) {
      const sid0 = u.toolCallId || u.id || "";
      const el0 = state.tools.get(sid0);
      if (!el0 || el0.querySelector(".spin") || !el0.querySelector("pre")) {
        SOFT.tools.set(sid0, u);
        softPush("tool", sid0);
      }
      return;
    }
    if (!quiet) hideWelcome();
    noteRunActivity();
    closeAllRecs();
    clearStreaming();
    const id = u.toolCallId || u.id || "tool-" + Date.now();
    let el = state.tools.get(id);
    if (!el) {
      el = document.createElement("div");
      el.className = state.replaying ? "tool" : "tool in";
      el.innerHTML = '<span class="tool-ic"></span><div class="tool-body"><div class="tool-title"></div></div>';
      msgWrap().appendChild(el);
      state.tools.set(id, el);
      setPill(null);
    }
    const status = u.status || "pending";
    const rawIn = u.rawInput || {};
    const shortInput = String(rawIn.command || rawIn.path || rawIn.file_path || rawIn.query || rawIn.url || rawIn.pattern || "").split("\n")[0].slice(0, 90);
    const title = u.title || u.kind || shortInput || "Herramienta";
    const t = el.querySelector(".tool-title");
    t.innerHTML = `${esc(title)}${u.kind && u.kind !== title ? ` <span class="tname">${esc(u.kind)}</span>` : ""}`;
    el.classList.toggle("ok", status === "completed");
    el.classList.toggle("err", status === "failed");
    const stale = el.querySelector(".tool-title .tint");
    if (stale && status !== "pending" && status !== "in_progress") stale.remove();
    const ic = el.querySelector(".tool-ic");
    ic.innerHTML = status === "pending" || status === "in_progress" ? '<span class="spin"></span>' : toolIconSvg(String(u.kind || (rawIn.command ? "shell" : rawIn.path || rawIn.file_path ? "read" : rawIn.query || rawIn.pattern ? "search" : rawIn.url ? "glob" : u.title || "")).split(/[ /]/)[0], status === "failed" ? "failed" : "ok");
    const texts = [];
    for (const c of u.content || []) {
      if (c && c.type === "content" && c.content && c.content.type === "text") texts.push(c.content.text);
      else if (c && c.type === "diff") texts.push("± " + (c.path || "archivo"));
    }
    if (texts.length) {
      let pre = el.querySelector("pre");
      if (!pre) {
        pre = document.createElement("pre");
        el.querySelector(".tool-body").appendChild(pre);
      }
      const all = texts.join("\n");
      pre.textContent = all.length > 6e3 ? all.slice(0, 6e3) + "\n…" : all;
      el.classList.add("has-content");
      requestAnimationFrame(() => {
        if (!el.isConnected || el.querySelector(".tool-more")) return;
        if (pre.scrollHeight <= pre.clientHeight + 8) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tool-more";
        btn.textContent = "Ver todo";
        btn.title = "Mostrar el contenido completo de esta herramienta";
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const abierto = el.classList.toggle("expandido");
          btn.textContent = abierto ? "Ver menos" : "Ver todo";
        });
        el.querySelector(".tool-body").appendChild(btn);
      });
    }
    if (!quiet) scrollBottom();
  }
  function softApply() {
    const res = { text: 0, tool: 0, user: 0, updated: 0 };
    const midOk = new Set([...document.querySelectorAll("#msg-inner .msg-user")].map((e) => e.dataset.mid).filter(Boolean));
    for (const [tipo, k] of SOFT.order) {
      if (tipo === "text") {
        const text = SOFT.text.get(k);
        if (text == null) continue;
        const rec = state.msgs.get(k);
        if (rec) {
          if (rec.text === text) continue;
          rec.text = text;
          rec.lastAppend = 0;
          rec.live = false;
          queueRender(rec);
          res.updated++;
        } else {
          streamAppend(k, text, SOFT.kind.get(k));
          res.text++;
        }
      } else if (tipo === "tool") {
        const u = SOFT.tools.get(k);
        if (u) {
          toolUpsert(u, true);
          res.tool++;
        }
      } else {
        const usr = SOFT.users[k];
        if (!usr) continue;
        if (usr.mid && midOk.has(usr.mid)) continue;
        addUser(usr.text, true, usr.atts, { mid: usr.mid, hidden: usr.hidden });
        res.user++;
      }
    }
    markHiddenTail();
    return res;
  }
  function sweepInterruptedTools() {
    if (state.busy) return 0;
    let n = 0;
    for (const el of state.tools.values()) {
      const spin = el.querySelector(".spin");
      if (!spin) continue;
      spin.remove();
      el.classList.add("err");
      const t = el.querySelector(".tool-title");
      if (t && !t.querySelector(".tint")) {
        const s = document.createElement("span");
        s.className = "tint";
        s.textContent = " · interrumpido (sin resultado)";
        t.appendChild(s);
      }
      n++;
    }
    if (n) WATCH_DBG.interrupted = (WATCH_DBG.interrupted || 0) + n;
    return n;
  }
  function unsweepInterruptedTools() {
    let n = 0;
    for (const el of state.tools.values()) {
      const t = el.querySelector(".tool-title .tint");
      if (!t) continue;
      t.remove();
      el.classList.remove("err");
      const ic = el.querySelector(".tool-ic");
      if (ic && !ic.querySelector(".spin")) ic.innerHTML = '<span class="spin"></span>';
      n++;
    }
    return n;
  }
  async function softResync(force) {
    if (state.hubWatch === true) return false;
    if (!state.current || !rpc.ready || state.resyncing) return false;
    const now = performance.now();
    if (!force && now - lastTypedAt < SOFT_QUIET_MS) {
      WATCH_DBG.softDeferred++;
      return false;
    }
    if (!force && now - lastSoftAt < SOFT_MIN_MS) {
      WATCH_DBG.softThrottled++;
      return false;
    }
    const box = $("#messages");
    const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    const keepTop = box ? box.scrollTop : 0;
    state.resyncing = true;
    SOFT.on = true;
    softReset();
    const t0 = performance.now();
    try {
      await rpc.request("session/load", { sessionId: state.current.id, cwd: state.current.cwd || CFG.cwd, mcpServers: [] });
    } catch (e) {
      report("error", "refresco suave: " + e.message);
    }
    SOFT.on = false;
    const parsed = softApply();
    flushRender();
    const nInt = sweepInterruptedTools();
    if (box && !atBottom) box.scrollTop = keepTop;
    else scrollBottom(true);
    const dt = performance.now() - t0;
    lastSoftAt = performance.now();
    softBackoffMs = dt > 4e3 ? 6e4 : dt > 1500 ? 3e4 : SOFT_REFRESH_MS;
    WATCH_DBG.softBackoffMs = softBackoffMs;
    WATCH_DBG.softResyncs++;
    WATCH_DBG.softMs += dt;
    if (dt > WATCH_DBG.maxSoftMs) WATCH_DBG.maxSoftMs = dt;
    WATCH_DBG.lastSoft = { ms: Math.round(dt), ...parsed, interrupted: nInt };
    report("refresh", "suave " + Math.round(dt) + "ms nuevos: texto=" + parsed.text + " tool=" + parsed.tool + " user=" + parsed.user + " actualizados=" + parsed.updated + " interrumpidas=" + nInt);
    state.resyncing = false;
    return true;
  }
  function showPermCard(m) {
    hideWelcome();
    noteRunActivity();
    const p = m.params || {};
    const tc = p.toolCall || {};
    const el = document.createElement("div");
    el.className = "perm";
    const cmd = tc.rawInput && (tc.rawInput.command || tc.rawInput.path) ? String(tc.rawInput.command || tc.rawInput.path) : "";
    const showCmd = cmd && !String(tc.title || "").includes(cmd.slice(0, 32));
    el.innerHTML = `<div class="perm-head">🔐 Aegis pide permiso para usar una herramienta</div><div class="perm-tool">${esc(tc.title || tc.kind || "Herramienta")}${showCmd ? ` — <code>${esc(cmd.slice(0, 220))}</code>` : ""}</div><div class="perm-btns"></div>`;
    const btns = el.querySelector(".perm-btns");
    const labels = {
      allow_once: ["Permitir una vez", "primary"],
      allow_always: ["Permitir siempre", ""],
      reject_once: ["Rechazar", "danger"],
      reject_always: ["Rechazar siempre", "danger"]
    };
    const order = ["allow_once", "allow_always", "reject_once", "reject_always"];
    const candidates = [...p.options || []].sort(
      (a, b) => (order.indexOf(a.optionId) + 1 || 9) - (order.indexOf(b.optionId) + 1 || 9)
    );
    for (const opt of candidates) {
      const [label, cls] = labels[opt.optionId] || [opt.name || opt.optionId, ""];
      const b = document.createElement("button");
      b.className = "pb " + cls;
      b.textContent = label;
      b.addEventListener("click", () => {
        rpc.respond(m.id, { outcome: { outcome: "selected", optionId: opt.optionId } });
        el.classList.add("answered");
        btns.querySelectorAll("button").forEach((x) => x.disabled = true);
        const ans = document.createElement("div");
        ans.className = "perm-answer";
        ans.textContent = "Respuesta: " + label;
        el.appendChild(ans);
      });
      btns.appendChild(b);
    }
    msgWrap().appendChild(el);
    scrollBottom(true);
  }
  function setPill(msg) {
    let p = $("#status-pill");
    if (!msg) {
      p?.remove();
      return;
    }
    if (!p) {
      p = document.createElement("div");
      p.id = "status-pill";
      p.className = "pill";
      msgWrap().appendChild(p);
    }
    p.innerHTML = '<span class="spin"></span>' + esc(msg);
    scrollBottom();
  }
  function systemNote(msg) {
    hideWelcome();
    report("sysnote", String(msg).slice(0, 300));
    const el = document.createElement("div");
    el.className = "sysnote";
    el.textContent = msg;
    msgWrap().appendChild(el);
    scrollBottom(true);
  }
  function modelParts() {
    const opts = state.current && state.current.configOptions || [];
    const val = (id) => {
      const o = opts.find((x) => x && x.id === id);
      if (!o || !Array.isArray(o.options)) return null;
      const cur = o.options.find((c) => c.value === o.currentValue) || o.options[0];
      return cur && (cur.name || cur.value) || null;
    };
    let model = val("model");
    let effort = val("thinking_effort");
    let fromAlias = false;
    const mm = /-(none|low|medium|high|max)$/.exec(String(model || ""));
    if (mm) {
      effort = mm[1] === "none" ? "off" : mm[1];
      fromAlias = true;
    }
    if (!model && !effort && !fromAlias) return null;
    return { model: model || val("provider"), effort, fromAlias };
  }
  function modelSummary() {
    const p = modelParts();
    if (!p) return null;
    return (p.model || "modelo ?") + (p.effort ? "  ·  esfuerzo: " + p.effort : "");
  }
  function usageLines() {
    const s = state.usage || {};
    const L = [];
    const m = modelSummary();
    if (m) L.push("Modelo: " + m);
    if (s.used != null) {
      const pct = s.limit ? Math.round(s.used / s.limit * 100) : null;
      L.push("Contexto: " + fmtTok(s.used) + (s.limit ? " de " + fmtTok(s.limit) + " tok (" + pct + "%)" : " tok (el server no informo limite)"));
      if (s.limit) {
        const trig = Math.round(compactTrig(s).at);
        L.push("Compacta sola a ~" + fmtTok(trig) + " (" + Math.round(COMPACT_RATIO * 100) + "%)  ·  margen " + fmtTok(Math.max(0, trig - s.used)) + " tok");
      }
    }
    if (s.inTok != null || s.outTok != null) L.push("Acumulado: entrada " + fmtTok(s.inTok || 0) + "  ·  salida " + fmtTok(s.outTok || 0));
    const mu = s.last;
    if (mu) {
      const b = [];
      if (mu.inputTokens != null) b.push("entrada " + fmtTok(mu.inputTokens));
      if (mu.outputTokens != null) b.push("salida " + fmtTok(mu.outputTokens));
      if (mu.cacheReadTokens != null) {
        const den = (mu.inputTokens || 0) + mu.cacheReadTokens;
        if (den > 0) b.push("cache " + Math.round(mu.cacheReadTokens / Math.max(1, mu.inputTokens || 0) * 100) + "%");
      }
      if (mu.elapsedMs != null) b.push((mu.elapsedMs / 1e3).toFixed(1) + "s");
      if (mu.timeToFirstTokenMs != null) b.push("1er token " + (mu.timeToFirstTokenMs / 1e3).toFixed(1) + "s");
      if (mu.isCompaction) b.push("COMPACTACION");
      if (b.length) L.push("Ultimo paso: " + b.join("  ·  "));
    }
    if (s.cost != null) L.push("Costo acumulado: " + fmtCost(s.cost));
    if (!L.length) L.push("Sin datos de uso todavia.");
    return L;
  }
  function resetUsageForSession() {
    const sid = state.current && state.current.id || null;
    if (state.usageSid === sid) return;
    const cache = state.usageBySid || (state.usageBySid = {});
    if (state.usageSid) cache[state.usageSid] = state.usage || {};
    state.usageSid = sid;
    state.usage = sid && cache[sid] || {};
    renderUsage();
  }
  let usagePop = null;
  const POP_PAD = 8, POP_GAP = 9;
  function popBox() {
    const vv = window.visualViewport;
    const vw = vv && vv.width || window.innerWidth;
    const vh = vv && vv.height || window.innerHeight;
    return {
      ox: vv && vv.offsetLeft || 0,
      oy: vv && vv.offsetTop || 0,
      vw,
      vh,
      // Techo de alto: el desglose completo (mas las filas por modelo) puede medir mas que
      // la pantalla; sin techo el panel no entra ni arriba ni abajo del readout.
      maxH: Math.max(140, vh - POP_PAD * 2)
    };
  }
  function closeUsagePop() {
    if (usagePop) usagePop.hidden = true;
  }
  function buildUsagePop() {
    if (usagePop) return usagePop;
    const w = document.createElement("div");
    w.id = "usage-pop";
    w.hidden = true;
    w.innerHTML = '<div class="up-h"><span>Contexto</span><i class="up-verdict"></i><b class="up-pct">--</b></div><div class="up-meter"><i></i><em></em></div><div class="up-sub"></div><div class="up-rows"></div><div class="up-foot"></div>';
    document.body.appendChild(w);
    usagePop = w;
    const b = popBox();
    w.style.maxHeight = b.maxH + "px";
    w.style.overflowY = "auto";
    w.style.overscrollBehavior = "contain";
    w.style.left = b.ox + POP_PAD + "px";
    w.style.top = b.oy + POP_PAD + "px";
    document.addEventListener("pointerdown", (e) => {
      if (!usagePop || usagePop.hidden) return;
      const a = $("#meta-right");
      if (usagePop.contains(e.target) || a && a.contains(e.target)) return;
      closeUsagePop();
    }, true);
    window.addEventListener("resize", placeUsagePop);
    window.addEventListener("scroll", placeUsagePop, true);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", placeUsagePop);
      window.visualViewport.addEventListener("scroll", placeUsagePop);
    }
    return w;
  }
  function placeUsagePop() {
    const w = usagePop;
    const a = $("#meta-right");
    if (!w || w.hidden || !a) return;
    const b = popBox();
    const mh = b.maxH + "px";
    if (w.style.maxHeight !== mh) {
      w.style.maxHeight = mh;
      w.style.overflowY = "auto";
    }
    const r = a.getBoundingClientRect();
    const pw = Math.min(w.offsetWidth, Math.max(160, b.vw - POP_PAD * 2));
    const ph = Math.min(w.offsetHeight, b.maxH);
    const spaceAbove = r.top - POP_GAP - POP_PAD;
    const spaceBelow = b.oy + b.vh - r.bottom - POP_GAP - POP_PAD;
    const above = ph <= spaceAbove || spaceAbove >= spaceBelow;
    let top = above ? r.top - POP_GAP - ph : r.bottom + POP_GAP;
    let left = r.right - pw;
    left = Math.max(b.ox + POP_PAD, Math.min(left, b.ox + b.vw - pw - POP_PAD));
    top = Math.max(b.oy + POP_PAD, Math.min(top, b.oy + b.vh - ph - POP_PAD));
    w.dataset.above = above ? "1" : "0";
    w.style.left = Math.round(left) + "px";
    w.style.top = Math.round(top) + "px";
  }
  const niceTok = (n) => {
    if (n == null) return "--";
    if (n < 1e3) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + "k";
    return (n / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
  };
  const popRow = (k, v) => '<div class="up-row"><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span></div>";
  function openUsagePop() {
    const w = buildUsagePop();
    const s = state.usage || {};
    const mp = modelParts() || {};
    const pct = s.limit && s.used != null ? Math.min(100, s.used / s.limit * 100) : null;
    const ct = compactTrig(s);
    const trig = ct.at;
    const trigPct = ct.pct != null ? ct.pct : COMPACT_RATIO * 100;
    const col = pct == null ? "var(--text-4)" : pct >= trigPct ? "var(--danger)" : pct >= 50 ? "var(--warn)" : "var(--ok)";
    w.querySelector(".up-pct").textContent = pct == null ? "--" : Math.round(pct) + "%";
    w.querySelector(".up-pct").style.color = col;
    const vd = w.querySelector(".up-verdict");
    vd.textContent = pct == null ? "sin medir todavia" : pct >= trigPct ? "va a compactar" : pct >= 50 ? "mas de la mitad" : "holgado";
    const bar = w.querySelector(".up-meter i");
    bar.style.background = col === "var(--text-4)" ? "var(--text-4)" : "linear-gradient(90deg, " + col + ", " + col + ")";
    w.querySelector(".up-meter em").style.left = Math.round(trigPct) + "%";
    w.querySelector(".up-sub").innerHTML = s.used == null ? "todavia sin datos de uso" : "<b>" + niceTok(s.used) + "</b> de " + niceTok(s.limit) + " tok" + (trig ? "  ·  compacta a " + niceTok(trig) + " (" + Math.round(trigPct) + "%)" + (ct.estimated ? " (estimado)" : "") : "");
    const mu = s.last || {};
    const rate = stepRate(mu);
    const cachePct = mu.cacheReadTokens != null && (mu.inputTokens || 0) + mu.cacheReadTokens > 0 ? Math.round(mu.cacheReadTokens / Math.max(1, mu.inputTokens || 0) * 100) + "%" : "--";
    w.querySelector(".up-rows").innerHTML = popRow("ultimo paso", "entrada " + niceTok(mu.inputTokens) + "  ·  salida " + niceTok(mu.outputTokens) + (mu.elapsedMs != null ? "  ·  " + (mu.elapsedMs / 1e3).toFixed(1) + "s" : "") + (rate === null ? "" : "  ·  " + (rate.kind === "generation" ? "generación " : "solicitud total ") + fmtTps(rate.value))) + popRow("cache", cachePct + (mu.timeToFirstTokenMs != null ? "  ·  1er token " + (mu.timeToFirstTokenMs / 1e3).toFixed(1) + "s" : "")) + popRow("sesion", "entrada " + niceTok(s.inTok) + "  ·  salida " + niceTok(s.outTok)) + popRow("margen", s.limit && s.used != null && trig ? niceTok(Math.max(0, trig - s.used)) + " tok antes de compactar" + (ct.estimated ? " (estimado)" : "") : "--");
    const cbd = Array.isArray(s.contextBreakdown) ? s.contextBreakdown : null;
    if (cbd && cbd.length) {
      const tot = cbd.reduce((a, p) => a + (p.tokens || 0), 0) || 1;
      const sep = '<div class="up-row" style="border-top:1px solid var(--line,#3a3a3a);margin-top:6px;padding-top:6px"><span class="k">desglose del contexto</span><span class="v">' + niceTok(tot) + " tok</span></div>";
      const body = cbd.map((p) => {
        const share = Math.round((p.tokens || 0) / tot * 100);
        const d = [p.count ? p.count + " msj" : null, p.detail || null].filter(Boolean).join(" &middot; ");
        return '<div class="up-row" style="padding-left:10px"><span class="k">' + esc(p.label) + '</span><span class="v">' + niceTok(p.tokens) + " &middot; " + share + "%" + (d ? '<span style="display:block;font-size:11px;opacity:.62">' + esc(d) + "</span>" : "") + "</span></div>";
      }).join("");
      w.querySelector(".up-rows").insertAdjacentHTML("beforeend", sep + body);
    } else {
      w.querySelector(".up-rows").insertAdjacentHTML("beforeend", popRow("desglose del contexto", "se completa al cerrar el proximo turno"));
    }
    (function() {
      const mid = "  " + String.fromCharCode(183) + "  ";
      const price = (m) => {
        const pr = pricesCache && pricesCache[m.provider + "/" + m.model] || null;
        if (!pr) return "";
        const eff = pr.inputEffective != null ? pr.inputEffective : pr.input;
        if (eff == null) return "";
        const usd = m.inputTokens / 1e6 * eff;
        return "  " + String.fromCharCode(183) + "  USD " + usd.toFixed(3);
      };
      let extra = "";
      if (Array.isArray(s.modelUsage) && s.modelUsage.length) {
        extra += s.modelUsage.map(function(m) {
          return popRow("  " + m.model, m.calls + " llam" + mid + "entrada " + niceTok(m.inputTokens) + mid + "salida " + niceTok(m.outputTokens) + price(m));
        }).join("");
      }
      if (s.compactionCalls) {
        extra += popRow("compactacion interna", s.compactionCalls + " llam" + mid + "entrada " + niceTok(s.compactionInputTokens) + mid + "salida " + niceTok(s.compactionOutputTokens));
      }
      if (extra) w.querySelector(".up-rows").insertAdjacentHTML("beforeend", extra);
    })();
    w.querySelector(".up-foot").textContent = (mp.model || "modelo ?") + (mp.effort ? "  ·  esfuerzo " + mp.effort + (mp.fromAlias ? " (alias)" : "") : "") + (s.cost != null ? "  ·  " + fmtCost(s.cost) : "");
    w.hidden = false;
    placeUsagePop();
    bar.style.transition = "none";
    bar.style.width = "0%";
    requestAnimationFrame(() => {
      bar.style.transition = "";
      bar.style.width = (pct == null ? 0 : pct) + "%";
    });
  }
  (function initJumpBottom() {
    const box = $("#messages");
    if (!box) return;
    const btn = document.createElement("button");
    btn.id = "jump-bottom";
    btn.type = "button";
    btn.setAttribute("aria-label", "Ir al ultimo mensaje");
    btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" width="17" height="17"><path d="M8 3v10M3.6 8.6 8 13l4.4-4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.addEventListener("click", () => scrollBottom(true));
    const host = document.querySelector(".main") || document.body;
    host.appendChild(btn);
    const sync = () => {
      const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
      btn.classList.toggle("show", gap > 240);
    };
    box.addEventListener("scroll", sync, { passive: true });
    setInterval(sync, 1200);
  })();
  if (!window.__usagePopKeys) {
    window.__usagePopKeys = true;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && usagePop && !usagePop.hidden) {
        closeUsagePop();
        e.stopPropagation();
      }
    }, true);
  }
  function renderUsage() {
    const el = $("#meta-right");
    if (!el) return;
    const dbg = state.usageDbg || (state.usageDbg = { setUsage: 0, setMsgUsage: 0, render: 0, lastSet: null, lastMsg: null });
    dbg.render++;
    const s = state.usage || {};
    if (s.used == null && s.cost == null) {
      el.textContent = "";
      el.removeAttribute("title");
      el.removeAttribute("data-level");
      return;
    }
    const pct = s.limit && s.used != null ? Math.round(s.used / s.limit * 100) : null;
    const flag = pct == null ? "" : pct >= COMPACT_RATIO * 100 ? "! " : pct >= 50 ? "~ " : "";
    const parts = [];
    if (pct != null) parts.push(pct + "%");
    if (s.used != null) parts.push(fmtTok(s.used) + (s.limit ? "/" + fmtTok(s.limit) : "") + " tok");
    if (s.cost != null) parts.push(fmtCost(s.cost));
    el.textContent = flag + parts.filter(Boolean).join("  ·  ");
    el.title = usageLines().join(String.fromCharCode(10)) + String.fromCharCode(10) + String.fromCharCode(10) + "Toque para ver el detalle en el chat.";
    el.dataset.level = pct == null ? "na" : pct >= COMPACT_RATIO * 100 ? "hot" : pct >= 50 ? "warm" : "ok";
    el.style.color = pct == null ? "" : pct >= COMPACT_RATIO * 100 ? "var(--danger, #e5484d)" : pct >= 50 ? "var(--warn, #d29922)" : "";
    el.style.cursor = "pointer";
    el.onclick = () => {
      try {
        openUsagePop();
      } catch (err) {
        report("error", "popover de contexto: " + (err && err.message ? err.message : err));
        console.error(err);
      }
    };
  }
  let pricesCache = null;
  fetch("./prices.json").then((r) => r.json()).then((p) => {
    pricesCache = p || {};
  }).catch(() => {
    pricesCache = {};
  });
  function setUsage(u) {
    const dbg = state.usageDbg || (state.usageDbg = { setUsage: 0, setMsgUsage: 0, lastSet: null, lastMsg: null });
    dbg.setUsage++;
    dbg.lastSet = u;
    resetUsageForSession();
    const s = state.usage || (state.usage = {});
    const t = u.used ?? u.totalTokens;
    if (t != null) s.used = t;
    if (u.contextLimit != null) s.limit = u.contextLimit;
    if (u.accumulatedCost != null) s.cost = u.accumulatedCost;
    if (u.cost != null && s.cost == null) s.cost = u.cost;
    if (u.accumulatedInputTokens != null) s.inTok = u.accumulatedInputTokens;
    if (u.accumulatedOutputTokens != null) s.outTok = u.accumulatedOutputTokens;
    if (Array.isArray(u.contextBreakdown) && u.contextBreakdown.length) s.contextBreakdown = u.contextBreakdown;
    if (u.autoCompactAt != null) s.autoCompactAt = u.autoCompactAt;
    if (Array.isArray(u.modelUsage) && u.modelUsage.length) s.modelUsage = u.modelUsage;
    if (u.compactionCalls != null) s.compactionCalls = u.compactionCalls;
    if (u.compactionInputTokens != null) s.compactionInputTokens = u.compactionInputTokens;
    if (u.compactionOutputTokens != null) s.compactionOutputTokens = u.compactionOutputTokens;
    if (u.autoCompactPct != null) s.autoCompactPct = u.autoCompactPct;
    renderUsage();
  }
  function setMsgUsage(update) {
    const u = update?.usage;
    const dbg = state.usageDbg || (state.usageDbg = { setUsage: 0, setMsgUsage: 0, lastSet: null, lastMsg: null });
    dbg.setMsgUsage++;
    dbg.lastMsg = u;
    resetUsageForSession();
    const s = state.usage || (state.usage = {});
    if (u && !state.replaying && !state.hubReplay && (!state.busy && !state.speed.note || update?.messageId && state.speed.messages.has(update.messageId))) s.last = u;
    speedExact(update);
    renderUsage();
  }
  state.speed = state.speed || { ticks: [], el: null, avgEl: null, timer: 0, runOut: 0, runGen: 0, latest: null, seen: /* @__PURE__ */ new Set(), messages: /* @__PURE__ */ new Set(), stepId: null, stepText: false, currentRate: false, runId: null, finished: false, note: null };
  function speedSpan(id, after) {
    let el = $("#" + id);
    if (el) return el;
    const bar = $("#runbar");
    if (!bar) return null;
    el = document.createElement("span");
    el.id = id;
    el.hidden = true;
    if (after && after.parentNode) after.parentNode.insertBefore(el, after.nextSibling);
    else bar.appendChild(el);
    return el;
  }
  function speedEl() {
    const el = speedSpan("runbar-tps", $("#runbar-time"));
    if (el) el.className = "runbar-tps";
    return el;
  }
  function speedAvgEl() {
    const el = speedSpan("runbar-avg", $("#runbar-tps") || speedEl());
    if (el) el.className = "runbar-avg";
    return el;
  }
  function speedRateLabel(rate, previous = false) {
    return (previous ? "última " : "") + (rate.kind === "generation" ? "generación " : "solicitud ") + fmtTps(rate.value);
  }
  function speedLabel() {
    const s = state.speed;
    if (s.currentRate && s.latest?.mid === s.stepId) return speedRateLabel(s.latest);
    const now = performance.now();
    const recent = s.ticks.filter((t) => now - t.at <= 4e3);
    if (recent.length >= 2) {
      const first = recent[0];
      const last = recent[recent.length - 1];
      const seconds = Math.max(0.4, (last.at - first.at) / 1e3);
      const chars = last.chars - first.chars;
      if (chars > 0) return "~" + fmtTps(chars / 4 / seconds);
    }
    return s.latest ? speedRateLabel(s.latest, true) : "— tok/s";
  }
  const compactRunBar = () => window.matchMedia("(max-width: 560px)").matches;
  function speedBadge(el, label) {
    if (!el) return;
    el.dataset.fullLabel = label;
    el.textContent = compactRunBar() ? label.replace(/^última generación /, "últ. ").replace(/^última solicitud /, "últ. sol. ").replace(/^generación /, "").replace(/^solicitud /, "sol. ") : label;
    el.title = label.startsWith("~") ? "Ritmo estimado de generación: " + label : label.startsWith("última ") ? "Última medición disponible (paso anterior): " + label : label.startsWith("solicitud ") ? "Throughput de solicitud completa (no generación): " + label : label.startsWith("generación ") ? "Ritmo medido de " + label : "Esperando tokens medidos o texto visible para estimar el ritmo";
    el.hidden = !label;
  }
  function speedPaint() {
    speedBadge(speedEl(), speedLabel());
    const avgEl = speedAvgEl();
    if (!avgEl) return;
    avgEl.textContent = "";
    avgEl.hidden = true;
  }
  function speedSummary() {
    const s = state.speed;
    return {
      last: s.latest?.value ?? null,
      kind: s.latest?.kind ?? null,
      avg: s.runOut > 0 && s.runGen > 0 ? s.runOut / (s.runGen / 1e3) : null,
      out: s.runOut
    };
  }
  function speedStart() {
    const s = state.speed;
    s.ticks = [];
    s.latest = null;
    s.runOut = 0;
    s.runGen = 0;
    s.runId = state.runId || null;
    s.finished = false;
    s.seen.clear();
    s.messages.clear();
    s.stepId = null;
    s.stepText = false;
    s.currentRate = false;
    s.note = null;
    clearInterval(s.timer);
    s.timer = setInterval(speedPaint, 300);
    speedPaint();
  }
  function speedReset() {
    const s = state.speed;
    clearInterval(s.timer);
    s.timer = 0;
    s.ticks = [];
    s.latest = null;
    s.finished = true;
    s.runId = null;
    s.seen.clear();
    s.messages.clear();
    s.stepId = null;
    s.stepText = false;
    s.currentRate = false;
    s.note = null;
    s.runOut = 0;
    s.runGen = 0;
    speedBadge($("#runbar-tps"), "");
    const avg = $("#runbar-avg");
    if (avg) {
      avg.textContent = "";
      avg.hidden = true;
    }
  }
  function speedStep(messageId, nonText = false) {
    const s = state.speed;
    if (!messageId || !state.busy || state.replaying || state.hubReplay || s.finished) return;
    s.messages.add(messageId);
    if (s.stepId === messageId) {
      if (nonText && (s.stepText || s.currentRate)) {
        s.stepText = false;
        s.currentRate = false;
        s.ticks = [];
        speedPaint();
      } else if (!nonText && (!s.stepText || s.currentRate)) {
        s.stepText = true;
        s.currentRate = false;
        s.ticks = [];
        speedPaint();
      }
      return;
    }
    s.stepId = messageId;
    s.stepText = !nonText;
    s.currentRate = false;
    s.ticks = [];
    speedPaint();
  }
  function speedChunk(text, messageId) {
    if (!text) return;
    const s = state.speed;
    if (!state.busy || state.replaying || state.hubReplay || s.finished) return;
    if (!messageId) {
      s.ticks = [];
      s.currentRate = false;
      s.stepId = null;
      speedPaint();
      return;
    }
    speedStep(messageId);
    const prev = s.ticks.length ? s.ticks[s.ticks.length - 1].chars : 0;
    s.ticks.push({ at: performance.now(), chars: prev + text.length });
    if (s.ticks.length > 240) s.ticks.splice(0, s.ticks.length - 240);
  }
  function speedExact(update) {
    const s = state.speed;
    const mid = update?.messageId;
    if (state.replaying || state.hubReplay || !mid || !update?.usage) return;
    if (s.finished) {
      if (!s.note || !s.messages.has(mid)) return;
    } else if (!state.busy) return;
    if (s.runId && state.runId && s.runId !== state.runId) return;
    if (!s.messages.has(mid)) return;
    if (s.seen.has(mid)) return;
    const rate = stepRate(update.usage);
    if (!rate || rate.kind === "request" && rate.durationMs < 1e3) return;
    s.seen.add(mid);
    const order = [...s.messages].indexOf(mid);
    if (!s.latest || order >= s.latest.order) {
      s.latest = { value: rate.value, kind: rate.kind, mid, order };
      s.currentRate = mid === s.stepId;
    }
    if (rate.kind === "generation") {
      s.runOut += update.usage.outputTokens;
      s.runGen += rate.durationMs;
    }
    if (s.finished) {
      const sum = speedSummary();
      s.note.innerHTML = speedNoteHtml(s.noteMs, sum);
      const bar = $("#runbar");
      if (bar && !bar.hidden && bar.classList.contains("done")) {
        const el = speedEl();
        speedBadge(el, sum.last === null ? "" : speedRateLabel({ value: sum.last, kind: sum.kind }));
        const avg = speedAvgEl();
        if (avg) {
          avg.textContent = sum.avg === null ? "" : "prom generación " + fmtTps(sum.avg) + " · " + sum.out + " tok";
          avg.hidden = sum.avg === null;
        }
      }
    } else speedPaint();
  }
  function speedFinish() {
    const s = state.speed;
    clearInterval(s.timer);
    s.timer = 0;
    s.finished = true;
    const sum = speedSummary();
    const el = speedEl();
    speedBadge(el, sum.last === null ? "" : speedRateLabel({ value: sum.last, kind: sum.kind }));
    const avgEl = speedAvgEl();
    if (avgEl) {
      avgEl.textContent = sum.avg === null ? "" : "prom generación " + fmtTps(sum.avg) + " · " + sum.out + " tok";
      avgEl.hidden = sum.avg === null;
    }
    return sum;
  }
  const stopNote = (sr) => {
    if (!sr || sr === "end_turn") return;
    const m = {
      cancelled: "Respuesta detenida.",
      max_tokens: "Se alcanzó el límite de tokens del modelo.",
      refusal: "El modelo rechazó la solicitud.",
      max_turn_requests: "Se alcanzó el límite de pasos con herramientas."
    };
    systemNote(m[sr] || "Fin: " + sr);
  };
  function clearMessages() {
    const box = $("#messages");
    if (box) box.querySelectorAll(".msg-inner, #tail-pill").forEach((n) => n.remove());
    else $("#msg-inner")?.remove();
    $("#status-pill")?.remove();
    hideWelcome();
  }
  function resetTransient() {
    state.msgs.clear();
    state.tools.clear();
    state.attachments = [];
    state.runId = null;
    state.adopted = false;
    liveRunRevision++;
    state.hubCursor = null;
    state.hubWatchSid = null;
    state.steers.clear();
    state.queue = [];
    state.goal = null;
    state.grind = null;
    renderGoalBar();
    stopRunWatch();
    renderAttachments();
    finishStream();
    runBarHide();
  }
  async function newSession() {
    if (!rpc.ready) {
      systemNote("Sin conexión con el backend - reintentando.");
      return;
    }
    clearTimeout(draftTimer);
    saveDraft();
    detachRunView();
    try {
      const res = await rpc.request("session/new", { cwd: CFG.cwd || void 0, mcpServers: [] });
      if (state.hubWatchSid) {
        const prev = state.hubWatchSid;
        state.hubWatchSid = null;
        await hubUnwatch(prev);
      }
      state.current = { id: res.sessionId, title: "Nuevo chat", cwd: CFG.cwd, configOptions: res.configOptions || [], modes: res.modes || {} };
      await aplicarPendientes(res.sessionId);
      resetTransient();
      clearMessages();
      showWelcome("new");
      loadDraft();
      readLoad();
      debateLoad();
      updateTitle();
      renderChips();
      markActive(res.sessionId);
      localStorage.setItem("gweb.last", res.sessionId);
      closeDrawer();
      $("#input").focus();
      startHubWatch().catch(() => {
      });
      refreshSessions();
    } catch (e) {
      systemNote("No se pudo crear la sesión: " + e.message);
    }
  }
  async function openSession(entry) {
    const targetId = entry.sessionId || entry.id;
    clearTimeout(draftTimer);
    saveDraft();
    resetUsageForSession();
    detachRunView();
    stopRunWatch();
    await renderSession(entry);
    if (state.current?.id !== targetId) return;
    await startHubWatch();
    pinBottom(1400);
  }
  let releasePin = null;
  function pinBottom(ms) {
    releasePin?.();
    const box = $("#messages");
    if (!box) return;
    state.pinUntil = performance.now() + (ms || 1200);
    const release = () => {
      if (releasePin === release) {
        state.pinUntil = 0;
        releasePin = null;
      }
      box.removeEventListener("wheel", release);
      box.removeEventListener("touchstart", release);
      box.removeEventListener("pointerdown", release);
    };
    releasePin = release;
    box.addEventListener("wheel", release, { passive: true });
    box.addEventListener("touchstart", release, { passive: true });
    box.addEventListener("pointerdown", release, { passive: true });
    let ultimaAltura = -1;
    const step = () => {
      if (!state.pinUntil || releasePin !== release) return;
      if (performance.now() > state.pinUntil) {
        release();
        return;
      }
      if (box.scrollHeight !== ultimaAltura) {
        ultimaAltura = box.scrollHeight;
        box.scrollTop = ultimaAltura;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const REPLAY_TAIL_MSGS = 24;
  const uidOf = (u) => u.messageId || u.toolCallId || u.sessionUpdate + "|" + (u.title || u.kind || "");
  async function paintReplayTwoPhase() {
    const buf = state.replayBuf;
    state.replayBuf = null;
    if (!buf || !buf.length) return;
    let seen = /* @__PURE__ */ new Set(), split = 0;
    for (let i = buf.length - 1; i >= 0; i--) {
      const id = uidOf(buf[i].update || {});
      seen.add(id);
      if (seen.size > REPLAY_TAIL_MSGS) {
        let j = i;
        while (j > 0 && uidOf(buf[j - 1].update || {}) === id) j--;
        split = j;
        break;
      }
    }
    try {
      state.replaying = true;
      for (let i = split; i < buf.length; i++) applyUpdate(buf[i]);
      await drainRender();
      state.replaying = false;
      flushRender();
      scrollBottom(true);
      if (!split) return;
      state.replaying = true;
      state.offscreen = document.createElement("div");
      state.offscreen.className = "msg-inner";
      for (let i = 0; i < split; i++) applyUpdate(buf[i]);
      await drainRender();
      state.replaying = false;
      flushRender();
      const real = $("#msg-inner");
      if (!real) return;
      const box = $("#messages");
      const antes = real.scrollHeight;
      const ref = real.firstChild;
      while (state.offscreen.firstChild) real.insertBefore(state.offscreen.firstChild, ref);
      const delta = real.scrollHeight - antes;
      if (box) box.scrollTop = box.scrollTop + delta;
    } finally {
      state.offscreen = null;
      state.replaying = false;
      flushRender();
      markHiddenTail();
    }
  }
  const REPLAY_TAIL = 400;
  const REPLAY_MAX_BLOCK = 65536;
  const replayMeta = (full) => ({
    // `full` (cargar todo): sin tope de bloque, para que el historial completo llegue entero.
    _meta: full ? { replayTail: 1e9 } : { replayTail: REPLAY_TAIL, replayMaxBlockBytes: REPLAY_MAX_BLOCK }
  });
  function tailPill(show) {
    const box = $("#messages");
    if (!box) return;
    let el = box.querySelector("#tail-pill");
    if (!show) {
      if (el) el.remove();
      return;
    }
    if (el) return;
    el = document.createElement("div");
    el.id = "tail-pill";
    el.style.cssText = "text-align:center;font-size:12px;opacity:.8;margin:6px 0 12px";
    el.innerHTML = "Para abrir rapido se cargaron los ultimos " + REPLAY_TAIL + ' mensajes. <button class="sk-btn" id="tail-full">Ver historial completo</button>';
    el.querySelector("#tail-full").onclick = (ev) => {
      ev.stopPropagation();
      el.remove();
      renderSession(state.current, { quiet: true, full: true });
    };
    box.insertBefore(el, box.firstChild);
  }
  let renderGen = 0;
  async function renderSession(entry, opts) {
    const gen = ++renderGen;
    const id = entry.sessionId || entry.id;
    if (state.current?.id !== id) {
      clearTimeout(draftTimer);
      saveDraft();
    }
    if (state.current?.id !== id && state.hubWatchSid) {
      const prev = state.hubWatchSid;
      state.hubWatchSid = null;
      hubUnwatch(prev);
    }
    state.current = { id, title: entry.title || "Sesión", cwd: entry.cwd, configOptions: entry.configOptions || [], modes: entry.modes || {} };
    resetTransient();
    clearMessages();
    updateTitle();
    markActive(id);
    closeDrawer();
    loadDraft();
    readLoad();
    debateLoad();
    localStorage.setItem("gweb.last", id);
    if (!opts || !opts.quiet) setPill("Cargando conversación.");
    if (!SOFT.on) {
      state.replayBuf = [];
      const replayBuffer = state.replayBuf;
      state.hideTail = false;
      setTimeout(() => {
        if (gen !== renderGen || state.current?.id !== id || state.replayBuf !== replayBuffer) return;
        const sobrante = state.replayBuf;
        state.replayBuf = null;
        for (const p of sobrante) {
          try {
            applyUpdate(p);
          } catch (e) {
          }
        }
        flushRender();
      }, 8e3);
    }
    state.replaying = true;
    try {
      const res = await rpc.request("session/load", { sessionId: id, cwd: state.current.cwd || CFG.cwd, mcpServers: [], ...replayMeta(!!(opts && opts.full)) });
      if (gen !== renderGen || state.current?.id !== id) return;
      if (res && Array.isArray(res.configOptions)) state.current.configOptions = res.configOptions;
      if (res && res.modes) state.current.modes = res.modes;
      renderChips();
    } catch (e) {
      if (gen === renderGen && state.current?.id === id) systemNote("No se pudo cargar la sesión: " + e.message);
    }
    if (gen !== renderGen || state.current?.id !== id) return;
    state.replaying = false;
    if (state.replayBuf) await paintReplayTwoPhase();
    else await drainRender();
    if (gen !== renderGen || state.current?.id !== id) return;
    clearStreaming();
    flushRender();
    setPill(null);
    if (state.msgs.size) hideWelcome();
    else showWelcome("empty", state.current.title);
    updateMetaHints();
    tailPill(!(opts && opts.full) && state.msgs.size >= REPLAY_TAIL);
    scrollBottom(true);
    pinBottom(1400);
  }
  let runStart = 0;
  let runTick = 0;
  let runDoneTimer = 0;
  let cancelTimer = 0;
  const fmtElapsed = (ms) => {
    const s = Math.max(0, ms || 0) / 1e3;
    return s < 60 ? s.toFixed(1) + " s" : Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  };
  function setRunBarText(full) {
    const el = $("#runbar-text");
    const bar = $("#runbar");
    if (!el || !bar) return;
    bar.dataset.fullStatus = full;
    renderRunBarText();
  }
  function renderRunBarText() {
    const bar = $("#runbar"), el = $("#runbar-text");
    if (!bar || !el) return;
    const full = bar.dataset.fullStatus || "";
    el.title = full;
    el.textContent = compactRunBar() ? bar.classList.contains("done") ? "Terminado" : bar.classList.contains("cancelling") ? "Deteniendo…" : full.startsWith("El corte no se confirmó") ? "Sin confirmar" : "Trabaja" : full;
  }
  function paintQueuedRunBar() {
    const bar = $("#runbar");
    if (!bar) return;
    let badge = $("#runbar-queued");
    const count = state.queue.length + state.steers.size;
    if (!badge && count) {
      badge = document.createElement("span");
      badge.id = "runbar-queued";
      badge.className = "runbar-queued";
      $("#runbar-text").after(badge);
    }
    if (badge) {
      badge.hidden = !state.busy || !count || bar.hidden;
      badge.textContent = compactRunBar() ? "pendiente" : count === 1 ? "1 pendiente" : count + " pendientes";
      badge.title = count === 1 ? "1 indicación pendiente del agente" : count + " indicaciones pendientes del agente";
    }
  }
  window.addEventListener("resize", () => {
    renderRunBarText();
    paintQueuedRunBar();
    const el = $("#runbar-tps");
    if (el) speedBadge(el, el.dataset.fullLabel || "");
  });
  const paintRunBar = () => {
    paintQueuedRunBar();
    const t = $("#runbar-time");
    if (t && runStart) t.textContent = fmtElapsed(performance.now() - runStart);
  };
  function runBarShow(text) {
    const bar = $("#runbar");
    if (!bar) return;
    clearTimeout(runDoneTimer);
    bar.hidden = false;
    bar.classList.remove("done", "cancelling");
    setRunBarText(text || "Aegis está trabajando…");
    paintQueuedRunBar();
    $("#btn-stop").disabled = false;
    if (!runStart) runStart = performance.now();
    paintRunBar();
    speedStart();
    clearInterval(runTick);
    runTick = setInterval(paintRunBar, 250);
  }
  function runBarHide() {
    const bar = $("#runbar");
    clearInterval(runTick);
    runTick = 0;
    clearTimeout(runDoneTimer);
    runDoneTimer = 0;
    clearTimeout(cancelTimer);
    cancelTimer = 0;
    runStart = 0;
    speedReset();
    if (bar) {
      bar.hidden = true;
      bar.classList.remove("done", "cancelling");
    }
    paintQueuedRunBar();
    $("#btn-stop").disabled = false;
  }
  function runBarDone(text, ms) {
    const bar = $("#runbar");
    clearInterval(runTick);
    runTick = 0;
    clearTimeout(cancelTimer);
    cancelTimer = 0;
    if (!bar) return;
    bar.hidden = false;
    bar.classList.remove("cancelling");
    bar.classList.add("done");
    setRunBarText(text);
    paintQueuedRunBar();
    $("#runbar-time").textContent = fmtElapsed(ms);
    speedFinish();
    $("#btn-stop").disabled = false;
    clearTimeout(runDoneTimer);
    runDoneTimer = setTimeout(() => {
      bar.hidden = true;
      bar.classList.remove("done");
      updateMetaHints();
    }, 6e3);
  }
  function speedNoteHtml(ms, sum) {
    const parts = ["fin del turno · " + fmtElapsed(ms)];
    if (sum.last !== null) parts.push(speedRateLabel({ value: sum.last, kind: sum.kind }));
    if (sum.avg !== null) parts.push("prom generación " + fmtTps(sum.avg) + " · " + sum.out + " tok");
    return esc(parts[0]) + parts.slice(1).map((p) => ' · <span class="te-tps">' + esc(p) + "</span>").join("");
  }
  function turnEndNote(ms) {
    const el = document.createElement("div");
    el.className = "turn-end";
    state.speed.note = el;
    state.speed.noteMs = ms;
    el.innerHTML = speedNoteHtml(ms, speedSummary());
    msgWrap().appendChild(el);
    document.querySelectorAll("#msg-inner .msg-regen").forEach((b) => b.remove());
    const ultimaA = [...document.querySelectorAll("#msg-inner > .msg-a")].filter((x) => !x.querySelector(".thought")).pop();
    if (ultimaA && !ultimaA.classList.contains("hidden-from-agent")) {
      const rg = document.createElement("button");
      rg.type = "button";
      rg.className = "msg-copy msg-regen";
      rg.textContent = "↻ Regenerar";
      rg.title = "Regenerar: el modelo vuelve a responder el último mensaje";
      rg.addEventListener("click", (ev) => {
        ev.stopPropagation();
        regenerateLast();
      });
      ultimaA.appendChild(rg);
    }
    scrollBottom(true);
  }
  function noteRunActivity() {
    if (state.replaying || state.busy || !state.current) return;
    if (!rpc.ready) return;
    state.adopted = true;
    setBusy(true, "Turno en curso (lo arrancó otra conexión)");
    report("adopt", "run adoptado desde otra conexión/reload");
  }
  function endRun(text) {
    state.adopted = false;
    stopRunWatch();
    if (state.busy) setBusy(false, text);
    sweepInterruptedTools();
  }
  function stopRun() {
    if (!state.current) return;
    report("cancel", "UI: detener turno");
    try {
      rpc.notify("session/cancel", { sessionId: state.current.id });
    } catch {
    }
    const bar = $("#runbar");
    if (bar && !bar.hidden) {
      bar.classList.add("cancelling");
      setRunBarText("Deteniendo…");
      $("#btn-stop").disabled = true;
    }
    systemNote("Cancelando…");
    clearTimeout(cancelTimer);
    cancelTimer = setTimeout(() => {
      const b = $("#runbar");
      if (!state.busy || !b || b.hidden) return;
      b.classList.remove("cancelling");
      setRunBarText("El corte no se confirmó — probá Detener otra vez");
      $("#btn-stop").disabled = false;
    }, 12e3);
  }
  let orphanTimer = 0;
  const orphanTickMs = () => state.hubWatch === true ? 5e3 : 15e3;
  function startOrphanWatch() {
    clearInterval(orphanTimer);
    HUB.orphanMissAt = 0;
    orphanTimer = setInterval(() => {
      if (state.hubWatch === true) hubOrphanTick();
      else orphanTickLegacy();
    }, orphanTickMs());
  }
  async function orphanTickLegacy() {
    if (!state.busy || state.adopted || state.resyncing || !rpc.ready || !state.current) return;
    const probe = await activeRunId().catch(() => ({ known: false, runId: null }));
    if (!state.current || !state.busy || state.adopted) return;
    if (probe.known && !probe.runId) {
      await new Promise((r) => setTimeout(r, 4e3));
      if (!state.busy || state.adopted || !state.current) return;
      const again = await activeRunId().catch(() => ({ known: false, runId: null }));
      if (!(again.known && !again.runId)) return;
      report("adopt", "turno huerfano detectado: se libera la consola (prompt sin respuesta)");
      systemNote("El turno anterior quedo sin cerrar (no hay run activo): se libero la consola para seguir.");
      setBusy(false, "Sin respuesta del turno anterior");
    }
  }
  function stopOrphanWatch() {
    clearInterval(orphanTimer);
    orphanTimer = 0;
  }
  function detachRunView() {
    if (!state.busy) return false;
    const sid = state.current && state.current.id;
    report("adopt", "cambio de chat con turno en curso: sigue corriendo (" + (sid || "?") + ")");
    state.busy = false;
    state.adopted = false;
    state.runId = null;
    runStart = 0;
    HUB.orphanMissAt = 0;
    stopRunWatch();
    stopOrphanWatch();
    runBarHide();
    $("#btn-send").hidden = false;
    $("#btn-stop").hidden = true;
    $("#btn-attach").classList.remove("busy");
    updateMetaHints();
    return true;
  }
  function setBusy(b, note, startAt) {
    const was = state.busy;
    state.busy = b;
    if (!b) readFlush();
    if (b) startOrphanWatch();
    else stopOrphanWatch();
    $("#btn-send").hidden = b;
    $("#btn-stop").hidden = !b;
    $("#btn-attach").classList.toggle("busy", b);
    if (b) {
      if (!was) {
        runStart = startAt || performance.now();
        runBarShow(note);
      }
    } else {
      const ms = runStart ? performance.now() - runStart : 0;
      runStart = 0;
      state.runId = null;
      finishStream();
      if (was) {
        runBarDone(note || "Respuesta completa", ms);
        turnEndNote(ms);
        state.adopted = false;
        stopRunWatch();
        settleSteers();
      }
    }
    updateMetaHints();
    if (!b) flushQueue().catch(() => {
    });
  }
  function updateMetaHints() {
    const l = $("#meta-left");
    if (!l) return;
    const hub = state.hubWatch === true && state.hubWatchers > 1 ? " · " + state.hubWatchers + " conexiones sobre esta sesión" : "";
    if (state.busy || !$("#runbar")?.hidden) {
      l.textContent = "";
    } else if (state.slashLoaded && state.slash.length) {
      l.textContent = "Enter envía · Shift+Enter salto de línea · / comandos · Ctrl+K buscar" + hub;
    } else {
      l.textContent = "Enter envía · Shift+Enter salto de línea · Ctrl+K buscar" + hub;
    }
  }
  const promptBlocks = (text, atts) => {
    const blocks = [];
    if (text) blocks.push({ type: "text", text });
    for (const a of atts || []) {
      if (a.kind === "text") {
        blocks.push({ type: "text", text: `📄 Archivo adjunto «${a.name}» (${a.size || a.text.length} caracteres):

\`\`\`\`
${a.text}
\`\`\`\`` });
      } else {
        blocks.push({ type: "image", mimeType: a.mimeType, data: a.data });
      }
    }
    return blocks;
  };
  function sessionMsgCount(sid) {
    const s = (state.sessions || []).find(function(x) {
      return x && x.sessionId === sid;
    });
    const n = s && s._meta && s._meta.messageCount;
    return typeof n === "number" ? n : null;
  }
  async function promptConRetry(text, atts, sidArg) {
    const sid = sidArg || state.current && state.current.id;
    const antes = sessionMsgCount(sid);
    const promptId = "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
    for (let intento = 1; intento <= 3; intento++) {
      try {
        return await rpc.request("session/prompt", { sessionId: sid, prompt: promptBlocks(text, atts), _meta: { promptId } });
      } catch (e) {
        const msg = String(e && e.message || e);
        const transitorio = /conexi|closed|ECONNRESET|socket|network/i.test(msg);
        if (!transitorio || intento === 3) throw e;
        systemNote("Se corto la conexion; verificando si tu mensaje llego...");
        await new Promise(function(r) {
          setTimeout(r, intento * 3e3);
        });
        for (let i = 0; i < 20 && !rpc.ready; i++) await new Promise(function(r) {
          setTimeout(r, 1e3);
        });
        let verificado = false;
        try {
          if (!rpc.ready) throw new Error("sin conexion");
          await refreshSessions();
          const despues = sessionMsgCount(sid);
          const corriendo = !!(sid && state.runningIds && state.runningIds.has(sid));
          const crecio = antes != null && despues != null && despues > antes;
          if (corriendo || crecio) {
            report("adopt", "el prompt ya habia llegado (" + (corriendo ? "turno corriendo" : "messageCount " + antes + "->" + despues) + "): no se reenvia");
            systemNote("La conexion volvio: tu mensaje ya estaba enviado.");
            try {
              await resyncAdoptedRun();
            } catch (e2) {
            }
            return {};
          }
          verificado = antes != null && despues != null;
        } catch (e3) {
        }
        if (!verificado) {
          const errNC = new Error("No se pudo confirmar si tu mensaje llego.");
          errNC.aegisNoConfirmado = true;
          throw errNC;
        }
      }
    }
  }
  var VOICE_PROVIDERS = ["groq", "model"];
  var VOICE_MIN_MS = 450, VOICE_MAX_MS = 9e4, VOICE_SILENCE_MS = 900, VOICE_RMS = 0.012;
  var VOICE_IDLE_MS = 8e3;
  var MIC = { rec: null, chunks: [], stream: null, ctx: null, analyser: null, buf: null, timer: 0, auto: false, granted: false, startedAt: 0, spoke: false, quietSince: 0 };
  function micSecure() {
    return !!window.isSecureContext;
  }
  function micInsert(txt) {
    const t = document.getElementById("input");
    if (!t) return;
    const s = t.selectionStart == null ? t.value.length : t.selectionStart;
    const e = t.selectionEnd == null ? t.value.length : t.selectionEnd;
    const pre = t.value.slice(0, s), post = t.value.slice(e);
    const sep = pre && !/\s$/.test(pre) ? " " : "";
    t.value = pre + sep + txt + post;
    const pos = (pre + sep + txt).length;
    try {
      t.setSelectionRange(pos, pos);
    } catch (err) {
    }
    t.dispatchEvent(new Event("input", { bubbles: true }));
    t.focus();
  }
  function micSetState(on) {
    const btn = document.getElementById("btn-mic");
    if (!btn) return;
    btn.classList.toggle("rec", !!on);
    btn.title = on ? "Grabando… tocá para cortar y transcribir" : "Dictar por voz (corta solo cuando te quedás callado)";
  }
  function micStop(discard) {
    if (!MIC.rec) return;
    if (discard) MIC.discard = true;
    try {
      MIC.rec.stop();
    } catch (e) {
    }
  }
  function micCleanup() {
    try {
      if (MIC.stream) MIC.stream.getTracks().forEach(function(x) {
        x.stop();
      });
    } catch (e) {
    }
    try {
      if (MIC.ctx && MIC.ctx.close) MIC.ctx.close();
    } catch (e) {
    }
    if (MIC.timer) {
      clearInterval(MIC.timer);
      MIC.timer = 0;
    }
    MIC.stream = null;
    MIC.ctx = null;
    MIC.analyser = null;
    MIC.buf = null;
  }
  function micWatch(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      MIC.ctx = ctx;
      MIC.analyser = an;
      MIC.buf = new Float32Array(an.fftSize);
      MIC.timer = setInterval(function() {
        if (!MIC.analyser || !MIC.buf) return;
        MIC.analyser.getFloatTimeDomainData(MIC.buf);
        let sum = 0;
        for (let i = 0; i < MIC.buf.length; i++) sum += MIC.buf[i] * MIC.buf[i];
        const rms = Math.sqrt(sum / MIC.buf.length);
        const now = Date.now();
        if (now - MIC.startedAt > VOICE_MAX_MS) {
          micStop();
          return;
        }
        if (MIC.auto && !MIC.spoke && now - MIC.startedAt > VOICE_IDLE_MS) {
          micStop(true);
          return;
        }
        if (rms >= VOICE_RMS) {
          MIC.spoke = true;
          MIC.quietSince = 0;
          return;
        }
        if (!MIC.spoke) return;
        if (!MIC.quietSince) {
          MIC.quietSince = now;
          return;
        }
        if (now - MIC.quietSince >= VOICE_SILENCE_MS) micStop();
      }, 100);
    } catch (e) {
      report("mic", "VAD no disponible: " + String(e && e.message || e));
    }
  }
  function micTranscribe(blob, idx, auto) {
    const i = idx || 0;
    const provider = VOICE_PROVIDERS[i];
    const btn = document.getElementById("btn-mic");
    if (!provider) {
      if (btn) btn.classList.remove("busy");
      systemNote("No pude transcribir con ningún proveedor (revisá GROQ_API_KEY o el proveedor activo).");
      handsFreeMaybe(600);
      return;
    }
    if (btn) btn.classList.add("busy");
    systemNote("Transcribiendo " + Math.round(blob.size / 1024) + " KB con " + provider + "…");
    const fr = new FileReader();
    fr.onload = function() {
      const b64 = String(fr.result).split(",")[1];
      const type = (blob.type || "audio/webm").split(";")[0];
      rpc.request("_aegis/unstable/dictation/transcribe", { audio: b64, mimeType: type, provider }).then(function(r) {
        if (btn) btn.classList.remove("busy");
        const txt = (r && r.text || "").trim();
        if (!txt) {
          systemNote("La transcripción vino vacía (" + provider + ").");
          handsFreeMaybe(600);
          return;
        }
        micDeliver(txt, auto);
      }).catch(function(e) {
        const msg = String(e && e.message || e).slice(0, 120);
        report("dictado", provider + " falló: " + msg);
        if (i + 1 < VOICE_PROVIDERS.length) {
          systemNote("Falló " + provider + " (" + msg + "). Pruebo con " + VOICE_PROVIDERS[i + 1] + "…");
          micTranscribe(blob, i + 1, auto);
          return;
        }
        if (btn) btn.classList.remove("busy");
        systemNote("Falló la transcripción: " + msg);
        handsFreeMaybe(1500);
      });
    };
    fr.onerror = function() {
      if (btn) btn.classList.remove("busy");
      systemNote("No pude leer el audio grabado.");
    };
    fr.readAsDataURL(blob);
  }
  function micDeliver(txt, auto) {
    systemNote("Dictado: " + txt.slice(0, 90));
    if (auto && !state.busy) {
      sendText(txt);
      return;
    }
    micInsert(txt);
  }
  function micStart(opts) {
    if (MIC.rec) {
      micStop();
      return;
    }
    if (!micSecure()) {
      systemNote("El micrófono necesita HTTPS (o localhost). Por esta dirección el navegador no lo permite: usá https://" + location.hostname + ":3789 (la misma UI con TLS) o la URL del túnel.");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      systemNote("Este navegador no soporta grabación de audio.");
      return;
    }
    MIC.auto = !!(opts && opts.auto);
    MIC.discard = false;
    MIC.spoke = false;
    MIC.quietSince = 0;
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function(st) {
      MIC.granted = true;
      MIC.stream = st;
      const mt = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
      MIC.chunks = [];
      const rec = mt ? new MediaRecorder(st, { mimeType: mt }) : new MediaRecorder(st);
      MIC.rec = rec;
      MIC.startedAt = Date.now();
      rec.ondataavailable = function(ev) {
        if (ev.data && ev.data.size) MIC.chunks.push(ev.data);
      };
      rec.onstop = function() {
        const ms = Date.now() - MIC.startedAt;
        const chunks = MIC.chunks;
        MIC.chunks = [];
        const discard = MIC.discard;
        const auto = MIC.auto;
        MIC.discard = false;
        MIC.auto = false;
        MIC.rec = null;
        micCleanup();
        micSetState(false);
        if (discard) {
          handsFreeMaybe(150);
          return;
        }
        const blob = new Blob(chunks, { type: (rec.mimeType || "audio/webm").split(";")[0] });
        if (!blob.size) {
          systemNote("No se grabó audio.");
          return;
        }
        if (ms < VOICE_MIN_MS) {
          systemNote("Grabación muy corta (" + ms + " ms): la descarto.");
          return;
        }
        micTranscribe(blob, 0, auto);
      };
      rec.start();
      micSetState(true);
      micWatch(st);
      if (!MIC.auto) systemNote("Grabando… tocá el micrófono para cortar, o quedate callado ~1 s y corta solo.");
    }).catch(function(e) {
      MIC.rec = null;
      MIC.auto = false;
      micSetState(false);
      if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
        MIC.denied = true;
        systemNote("El navegador bloqueó el micrófono. Habilitalo para este sitio y volvé a prender Debate.");
        return;
      }
      systemNote("No pude abrir el micrófono: " + String(e && e.message || e).slice(0, 140));
    });
  }
  var DEBATE = DEBATE || { on: false, prev: "auto" };
  var HF = { on: false };
  var VOICE_SETTLE = /^\s*(dale|adelante|ejecut[aá]|hacelo|hacélo|metele|arranc[aá]|vamos|ok[, ]+(dale|hacelo|ejecut)|listo[, ]+(dale|hacelo))/i;
  var DEBATE_PREAMBLE = '[Debate: no uses herramientas ni edites archivos; discutí el plan, marcá riesgos y hacé preguntas. Arrancás a trabajar cuando diga "dale".]';
  function debateKeyFor(id) {
    return "aegis.debate." + (id || "nuevo");
  }
  function debateLoad() {
    if (!DEBATE) DEBATE = { on: false, prev: "auto" };
    try {
      DEBATE.on = localStorage.getItem(debateKeyFor(state.current && state.current.id)) === "1";
    } catch (e) {
      DEBATE.on = false;
    }
    if (HF) HF.on = false;
    debateSyncBtn();
    return DEBATE.on;
  }
  function debateSyncBtn() {
    const b = document.getElementById("btn-debate");
    if (!b || !DEBATE) return;
    b.classList.toggle("on", !!DEBATE.on);
    b.textContent = DEBATE.on ? "Debate · ON" : HF && HF.on ? "Manos libres" : "Debate";
    b.setAttribute("aria-pressed", DEBATE.on ? "true" : "false");
    b.title = DEBATE.on ? 'Modo debate ENCENDIDO: el bot conversa y NO puede usar herramientas. Decí "dale" para pasar a trabajar.' : "Modo debate: discutir el plan antes de que el bot toque nada (sin herramientas).";
  }
  function debateCurrentMode() {
    const m = state.current && state.current.modes;
    return m && (m.currentModeId || m.current_mode_id) || "auto";
  }
  async function debateSetMode(modeId) {
    const sid = state.current && state.current.id;
    if (!sid) return false;
    try {
      await rpc.request("session/set_mode", { sessionId: sid, modeId });
      if (state.current) {
        if (!state.current.modes) state.current.modes = {};
        state.current.modes.currentModeId = modeId;
      }
      return true;
    } catch (e) {
      systemNote("No pude cambiar el modo a " + modeId + ": " + String(e && e.message || e).slice(0, 120));
      return false;
    }
  }
  async function debateToggle() {
    const next = !(DEBATE && DEBATE.on);
    if (next) {
      DEBATE.prev = debateCurrentMode();
      if (!await debateSetMode("chat")) return;
    } else if (!await debateSetMode(DEBATE.prev || "auto")) return;
    DEBATE.on = next;
    try {
      localStorage.setItem(debateKeyFor(state.current && state.current.id), next ? "1" : "0");
    } catch (e) {
    }
    debateSyncBtn();
    if (next) {
      HF.on = true;
      if (!READ_ON) readToggle(true);
      systemNote('Modo debate: micrófono abierto y respuestas en voz alta. Hablá; decí "dale" para que ejecute.');
      if (!state.busy && !AUD.playing && !AUD.q.length) micStart({ auto: true });
      else handsFreeMaybe(800);
    } else {
      HF.on = false;
      if (MIC.rec) {
        if (MIC.spoke) micStop();
        else micStop(true);
      }
      systemNote("Modo trabajo: herramientas habilitadas.");
    }
    debateSyncBtn();
  }
  function debateDecorate(text) {
    const t = String(text || "");
    if (!DEBATE || !DEBATE.on) return t;
    if (VOICE_SETTLE.test(t) && t.length <= 90) return t;
    return DEBATE_PREAMBLE + "\n\n" + t;
  }
  async function debateSettle(text) {
    if (!DEBATE || !DEBATE.on) return false;
    const t = String(text || "");
    if (!VOICE_SETTLE.test(t) || t.length > 90) return false;
    DEBATE.on = false;
    try {
      localStorage.setItem(debateKeyFor(state.current && state.current.id), "0");
    } catch (e) {
    }
    await debateSetMode("auto");
    debateSyncBtn();
    systemNote('Modo trabajo: "dale" detectado, ejecutando.');
    return true;
  }
  function handsFreeOn() {
    return !!(HF && HF.on) && READ_ON;
  }
  function handsFreeMaybe(delay) {
    if (!handsFreeOn() || state.busy || MIC.rec) return;
    if (document.visibilityState !== "visible") return;
    if (MIC.denied) return;
    if (AUD.playing || AUD.q.length) return;
    setTimeout(function() {
      if (handsFreeOn() && !state.busy && !MIC.rec && !AUD.playing && !AUD.q.length) micStart({ auto: true });
    }, typeof delay === "number" ? delay : 700);
  }
  (function bindMic() {
    const btn = document.getElementById("btn-mic");
    if (btn) btn.addEventListener("click", function() {
      if (!MIC.rec && HF && HF.on) {
        HF.on = false;
        debateSyncBtn();
        systemNote("Manos libres apagado. Tocá el micrófono otra vez para dictar a mano.");
        return;
      }
      micStart();
    });
    const dbg = document.getElementById("btn-debate");
    if (dbg) dbg.addEventListener("click", function() {
      debateToggle();
    });
  })();
  let chunksTurn = 0;
  let textoDelTurno = "";
  const DESCARGAS_VISTAS = /* @__PURE__ */ new Set();
  let descargasTimer = null;
  function ofrecerDescargas() {
    const inner = document.querySelector("#msg-inner");
    if (!inner) return;
    const sid = state.current && state.current.id || "";
    const re = /\/dl\/([A-Za-z0-9._-]{1,120})/g;
    const mensajes = inner.querySelectorAll(".msg-a");
    for (const nodo of Array.from(mensajes)) {
      const texto = nodo.querySelector(":scope > .content")?.innerText || "";
      const enlaces = new Set(Array.from(nodo.querySelectorAll('.content a.dl-chip[href^="/dl/"]')).map((a) => decodeURIComponent(a.getAttribute("href").slice(4))));
      const legacyRow = nodo.querySelector(":scope > .dl-row");
      legacyRow?.querySelectorAll('a.dl-chip[href^="/dl/"]').forEach((a) => {
        if (enlaces.has(decodeURIComponent(a.getAttribute("href").slice(4)))) a.remove();
      });
      if (legacyRow && !legacyRow.children.length) legacyRow.remove();
      const nombres = [];
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(texto)) !== null) {
        const clave = sid + ":" + m[1];
        if (enlaces.has(m[1])) {
          DESCARGAS_VISTAS.add(clave);
          continue;
        }
        if (!DESCARGAS_VISTAS.has(clave)) {
          DESCARGAS_VISTAS.add(clave);
          nombres.push(m[1]);
        }
      }
      if (!nombres.length) continue;
      let row = nodo.querySelector(":scope > .dl-row");
      if (!row) {
        row = document.createElement("div");
        row.className = "dl-row";
        nodo.appendChild(row);
      }
      for (const nombre of nombres) {
        const a = document.createElement("a");
        a.className = "dl-chip";
        a.href = "/dl/" + encodeURIComponent(nombre);
        a.setAttribute("download", nombre);
        const ico = document.createElement("span");
        ico.className = "dl-ico";
        ico.textContent = "↓";
        const et = document.createElement("span");
        et.textContent = nombre;
        a.append(ico, et);
        row.appendChild(a);
      }
    }
  }
  const descargasObs = new MutationObserver(() => {
    clearTimeout(descargasTimer);
    descargasTimer = setTimeout(ofrecerDescargas, 400);
  });
  descargasObs.observe(document.body, { childList: true, subtree: true, characterData: true });
  function avisoTurnoVacio(texto, atts) {
    systemNote("El turno volvió vacío: el proveedor cortó la respuesta y no llegó contenido. Podés reintentar.");
    const row = document.createElement("div");
    row.className = "retry-row";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "retry-btn";
    b.textContent = "Reintentar";
    b.addEventListener("click", function() {
      row.remove();
      sendText(texto, atts);
    });
    row.appendChild(b);
    msgWrap().appendChild(row);
    scrollBottom();
  }
  async function sendText(text, atts, bubble) {
    await debateSettle(text);
    const wire2 = debateDecorate(text);
    chunksTurn = 0;
    textoDelTurno = "";
    state.hideTail = false;
    const el = bubble || addUser(text, false, atts);
    const sid = state.current && state.current.id;
    state.adopted = false;
    setBusy(true, "Aegis está trabajando.");
    const turnStartedAt = runStart;
    markRun(sid, true);
    let label = "Respuesta completa";
    let loMandoComoIndicacion = false;
    try {
      const res = await promptConRetry(wire2, atts, sid);
      if (!(state.current && state.current.id === sid)) {
        report("adopt", "turno terminó en " + (sid || "?") + " con la vista en otro chat");
        return;
      }
      if (res && res.usage && res.usage.totalTokens != null) setUsage({ used: res.usage.totalTokens });
      stopNote(res && res.stopReason);
      const sr = res && res.stopReason;
      if (chunksTurn === 0 && sr !== "cancelled") avisoTurnoVacio(text, atts);
      if (sr === "end_turn" && chunksTurn > 0) ofrecerDescargas();
      if (sr === "cancelled") label = "Turno detenido";
      else if (sr && sr !== "end_turn") label = "Turno interrumpido (" + sr + ")";
    } catch (e) {
      if (e && e.aegisNoConfirmado) {
        label = "No se pudo confirmar el envío";
        if (state.current && state.current.id === sid) {
          const inp = document.getElementById("input");
          if (inp && !inp.value.trim()) {
            inp.value = text;
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            inp.focus();
          }
        }
        systemNote("No pude confirmar si tu mensaje llegó (la conexión no volvió a tiempo). Te lo dejé en el composer: mirá si arriba quedó la respuesta y, si no, reenvialo.");
        return;
      }
      if (!(state.current && state.current.id === sid)) {
        report("error", "prompt de " + (sid || "?") + " falló con la vista en otro chat: " + String(e && e.message || e).slice(0, 140));
        return;
      }
      const active = /already has (?:an )?active run [`'"]([^`'"]+)[`'"]/i.exec(String(e && e.message || ""));
      if (active) {
        loMandoComoIndicacion = true;
        const ok = await steerTo(active[1], text, atts, el, "Turno en curso: tu mensaje va como indicación.");
        label = ok ? "Tu mensaje fue al turno en curso" : "No se pudo mandar la indicación al turno en curso";
        if (!ok) systemNote("El turno en curso no aceptó la indicación: probá de nuevo cuando termine.");
      } else {
        label = "Se cortó la conexión: el turno se interrumpió";
        systemNote("Error: " + e.message);
      }
    } finally {
      const stillMine = !!(state.current && state.current.id === sid);
      if (stillMine) {
        if (loMandoComoIndicacion && state.busy) {
          runBarShow(ADOPTED_NOTE);
          startRunWatch();
        } else if (state.busy && runStart === turnStartedAt) {
          setBusy(false, label);
        }
        flushQueue();
      } else {
        report("adopt", "turno de " + (sid || "?") + " cerrado sin tocar la vista actual");
      }
      if (sid && el && el.dataset && el.dataset.mid && hiddenFromId(sid)) setResume(sid, el.dataset.mid);
      markRun(sid, false);
      refreshSessions();
    }
    handsFreeMaybe(900);
  }
  async function send() {
    const input = $("#input");
    const text = input.value.trim();
    const atts = state.attachments.slice();
    if (state.busy) return steerOrQueue(text, atts);
    if (!text && !atts.length) return;
    if (!rpc.ready) {
      systemNote("Sin conexión con el backend - reintentando.");
      return;
    }
    if (!state.current) await newSession();
    if (!state.current) return;
    input.value = "";
    autosize();
    refreshSlashMenu();
    saveDraft();
    state.attachments = [];
    renderAttachments();
    await sendText(text, atts);
  }
  async function steerOrQueue(text, atts) {
    if (!rpc.ready) {
      systemNote("Sin conexión con el backend - reintentando.");
      return;
    }
    const attsText = (atts || []).filter((a) => a.kind === "text");
    if (!text && !attsText.length) {
      systemNote("Para una indicación al vuelo necesito texto (las imágenes van en el próximo mensaje).");
      return;
    }
    const input = $("#input");
    input.value = "";
    autosize();
    refreshSlashMenu();
    saveDraft();
    state.attachments = [];
    renderAttachments();
    const el = addUser(text, false, attsText, { queued: true });
    let rid = state.runId;
    if (!rid) {
      const probe = await activeRunId();
      if (probe.runId) {
        rid = probe.runId;
        state.runId = rid;
        state.adopted = true;
        startRunWatch();
      }
    }
    if (rid && await steerTo(rid, text, attsText, el)) return;
    state.queue.push({ text, atts: attsText });
    paintQueuedRunBar();
    setQueuedNote(el, "se enviará al terminar el turno");
  }
  async function steerTo(runId, text, atts, el, note) {
    if (!rpc.ready || !state.current) return false;
    try {
      const res = await rpc.request("_aegis/unstable/session/steer", {
        sessionId: state.current.id,
        prompt: promptBlocks(text, atts || []),
        expectedRunId: runId
      });
      const mid = res && res.messageId || null;
      if (mid) {
        state.steers.set(mid, { el, text, atts: atts || [] });
        paintQueuedRunBar();
        if (el && el.isConnected) el.dataset.mid = mid;
        trackPending(mid, text);
      }
      state.runId = runId;
      state.adopted = true;
      startRunWatch();
      setQueuedNote(el, note || "indicación en cola para el agente.");
      return true;
    } catch (e) {
      report("steer", "falló: " + e.message);
      return false;
    }
  }
  function markSteerDelivered(messageId) {
    const info = state.steers.get(messageId);
    if (!info) return;
    state.steers.delete(messageId);
    paintQueuedRunBar();
    untrackPending(messageId);
    if (info.el) {
      info.el.classList.remove("queued");
      identifyUserBubble(info.el, messageId);
    }
    setQueuedNote(info, "indicación recibida por el agente");
  }
  async function flushQueue() {
    if (state.busy || !state.queue.length) return;
    if (!rpc.ready) return;
    const q = state.queue.slice();
    state.queue = [];
    paintQueuedRunBar();
    const text = q.map((x) => x.text).filter(Boolean).join("\n\n");
    const atts = q.flatMap((x) => x.atts || []);
    if (!text && !atts.length) return;
    if (!state.current) return;
    await sendText(text, atts);
  }
  const WATCH_DBG = {
    ticks: 0,
    infos: 0,
    infoErrs: 0,
    keys: [],
    resyncs: 0,
    resyncMs: 0,
    maxResyncMs: 0,
    lastKey: "",
    prevKey: "",
    softResyncs: 0,
    softMs: 0,
    maxSoftMs: 0,
    softDeferred: 0,
    softThrottled: 0,
    interrupted: 0,
    lastSoft: null,
    // (v6.4) diagnóstico del hub por sesión (watch / replay / reconexión)
    hubWatches: 0,
    hubRewatches: 0,
    hubGaps: 0,
    hubErrs: 0,
    hubInfoErrs: 0,
    hubUnsupported: 0,
    hubRunStarts: 0,
    hubOrphanFrees: 0
  };
  const RUN_WATCH_MS = 2500;
  let runWatch = 0;
  let watchKey = "";
  let watchSince = 0;
  const ADOPTED_NOTE = "Turno en curso (lo arrancó otra conexión)";
  const HUB = { text: /* @__PURE__ */ new Map(), kind: /* @__PURE__ */ new Map(), gapRecovering: false, orphanMissAt: 0 };
  function hubApplyReplayText() {
    for (const [key, text] of HUB.text) {
      const thought = HUB.kind.get(key);
      const rec = state.msgs.get(key);
      if (!rec || rec.closed) {
        streamAppend(key, text, thought);
        continue;
      }
      const shown = rec.text || "";
      let n = 0;
      while (n < shown.length && n < text.length && shown[n] === text[n]) n++;
      if (n < text.length) streamAppend(key, text.slice(n), thought);
    }
    HUB.text.clear();
    HUB.kind.clear();
  }
  function hubMethodUnsupported(e) {
    const txt = String(e && e.message || "") + " " + (e && e.data ? JSON.stringify(e.data) : "");
    return e && e.code === -32601 || /method not found|not supported|no soportado|unknown method|unsupported/i.test(txt);
  }
  async function runIdFromInfo() {
    if (!rpc.ready || !state.current) return { known: false, runId: null };
    try {
      const info = await rpc.request("_aegis/unstable/session/info", { sessionId: state.current.id });
      const meta = info && info.session && info.session._meta || {};
      if (typeof meta.watcherCount === "number") state.hubWatchers = meta.watcherCount;
      if (meta.activeRunId === void 0) return { known: false, runId: null };
      return { known: true, runId: meta.activeRunId || null };
    } catch {
      WATCH_DBG.hubInfoErrs++;
      return { known: false, runId: null };
    }
  }
  async function hubUnwatch(sessionId) {
    try {
      await rpc.request("_aegis/unstable/session/unwatch", { sessionId });
    } catch {
    }
  }
  function userBubbleOnScreen(mid) {
    const nodes = document.querySelectorAll("#msg-inner .msg-user");
    for (let i = nodes.length - 1; i >= 0 && i >= nodes.length - 3; i--) if (nodes[i].dataset.mid === mid) return true;
    return false;
  }
  function adoptLocalEcho(mid, text) {
    const nodes = document.querySelectorAll("#msg-inner .msg-user");
    const needle = wordsOf(text);
    const matches = [];
    for (let i = nodes.length - 1; i >= 0 && i >= nodes.length - 4; i--) {
      const el = nodes[i];
      if (el.dataset.mid || el.classList.contains("queued")) continue;
      const shown = wordsOf(el.textContent);
      if (shown && needle && (shown === needle || needle.startsWith(shown))) matches.push(el);
    }
    return matches.length === 1 && identifyUserBubble(matches[0], mid);
  }
  function adoptLocalImage(mid, content) {
    if (!content || !content.data || !content.mimeType) return false;
    const nodes = document.querySelectorAll("#msg-inner .msg-user");
    const src = "data:" + content.mimeType + ";base64," + content.data;
    const matches = [];
    for (let i = nodes.length - 1; i >= 0 && i >= nodes.length - 4; i--) {
      const el = nodes[i];
      if (el.dataset.mid || el.classList.contains("queued")) continue;
      if ([...el.querySelectorAll("img")].some((img) => img.src === src)) matches.push(el);
    }
    return matches.length === 1 && identifyUserBubble(matches[0], mid);
  }
  function hubApplyReplay(replay) {
    let gap = false;
    state.hubReplay = true;
    HUB.text.clear();
    HUB.kind.clear();
    try {
      for (const n of replay || []) {
        if (!n || !n.method) continue;
        if (n.method === "_aegis/unstable/session/replay_gap") {
          gap = true;
          continue;
        }
        handleServerMessage(n);
      }
    } finally {
      state.hubReplay = false;
      hubApplyReplayText();
    }
    return gap;
  }
  async function watchSession(since, opts) {
    if (!state.current || !rpc.ready) return "error";
    const sid = state.current.id;
    const revisionAtRequest = liveRunRevision;
    if (state.hubWatchSid && state.hubWatchSid !== sid) {
      const prev = state.hubWatchSid;
      state.hubWatchSid = null;
      state.hubCursor = null;
      hubUnwatch(prev);
    }
    try {
      let timedOut = false;
      let timeout;
      const request = rpc.request("_aegis/unstable/session/watch", { sessionId: sid, since: since == null ? null : since });
      request.then(() => {
        if (timedOut && state.current?.id !== sid) hubUnwatch(sid);
      }).catch(() => {
      });
      const res = await Promise.race([
        request,
        new Promise((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            resolve(null);
          }, 8e3);
        })
      ]);
      clearTimeout(timeout);
      if (res === null) {
        if (state.current?.id === sid) state.hubWatch = false;
        report("watch", "session/watch sin respuesta en 8 s: se mantiene el refresco viejo");
        return "unsupported";
      }
      if (!(state.current && state.current.id === sid)) {
        hubUnwatch(sid);
        return "ok";
      }
      if (!res || typeof res !== "object" || typeof res.cursor !== "number") {
        state.hubWatch = false;
        state.hubWatchSid = null;
        WATCH_DBG.hubUnsupported = 1;
        report("watch", "respuesta de session/watch sin cursor: se mantiene el refresco viejo");
        return "unsupported";
      }
      state.hubWatch = true;
      state.hubWatchSid = sid;
      const rewound = typeof since === "number" && res.cursor < since;
      state.hubCursor = rewound ? res.cursor : Math.max(state.hubCursor || 0, res.cursor);
      if (res && typeof res.watcherCount === "number") state.hubWatchers = res.watcherCount;
      WATCH_DBG.hubWatches++;
      const liveRidBeforeReplay = state.runId;
      const gap = hubApplyReplay(res && res.replay);
      if (liveRunRevision !== revisionAtRequest) state.runId = liveRidBeforeReplay;
      if (res && res.activeRunId !== void 0 && liveRunRevision === revisionAtRequest) {
        applyActiveRunId(res.activeRunId || null);
      }
      if (!opts || !opts.quiet) report("watch", "enganchado " + sid.slice(0, 12) + " cursor=" + state.hubCursor + " replay=" + (res && res.replay && res.replay.length || 0) + (res && res.activeRunId ? " run=" + res.activeRunId : ""));
      updateMetaHints();
      return gap || rewound ? "gap" : "ok";
    } catch (e) {
      if (hubMethodUnsupported(e)) {
        state.hubWatch = false;
        state.hubWatchSid = null;
        WATCH_DBG.hubUnsupported = 1;
        report("watch", "server sin _aegis/unstable/session/watch: se mantiene el refresco viejo (" + String(e && e.message || "").slice(0, 120) + ")");
        return "unsupported";
      }
      WATCH_DBG.hubErrs++;
      report("watch", "watch falló: " + String(e && e.message || e).slice(0, 200));
      return "error";
    }
  }
  async function hubLoadAndRewatch() {
    if (!state.current || !rpc.ready) return "error";
    const keep = {
      runId: state.runId,
      adopted: state.adopted,
      busy: state.busy,
      start: runStart,
      atts: state.attachments.slice(),
      queue: state.queue.slice(),
      steers: [...state.steers.entries()]
    };
    state.hubCursor = null;
    state.resyncing = true;
    try {
      await renderSession(state.current, { quiet: true });
    } catch (e) {
      report("error", "recarga por hub: " + e.message);
    }
    state.runId = keep.runId;
    state.adopted = keep.adopted;
    state.queue = keep.queue;
    state.steers = new Map(keep.steers);
    state.attachments = keep.atts;
    renderAttachments();
    if (keep.busy) {
      runStart = keep.start || performance.now();
      setBusy(true, ADOPTED_NOTE);
      const bar = $("#runbar");
      if (bar && bar.hidden) runBarShow(ADOPTED_NOTE);
    }
    state.resyncing = false;
    return await watchSession(null, { quiet: true });
  }
  async function hubFullResync() {
    if (HUB.gapRecovering) return false;
    HUB.gapRecovering = true;
    try {
      WATCH_DBG.hubGaps++;
      report("watch", "replay_gap: session/load completo + re-watch");
      await hubLoadAndRewatch();
      return true;
    } finally {
      HUB.gapRecovering = false;
    }
  }
  function onReplayGap(params) {
    const sid = params && params.sessionId;
    if (sid && state.current && sid !== state.current.id) return;
    if (state.hubWatch !== true) return;
    hubFullResync().catch(() => {
    });
  }
  async function hubRewatch() {
    if (!state.current || !rpc.ready) return false;
    WATCH_DBG.hubRewatches++;
    const r = await watchSession(state.hubCursor);
    if (r === "unsupported" || r === "error") {
      await checkAdoptedRun();
      return false;
    }
    if (r === "gap") {
      await hubFullResync();
      return true;
    }
    if (!state.busy) {
      sweepInterruptedTools();
      flushPendingSteers();
    }
    return true;
  }
  async function startHubWatch() {
    if (state.hubWatch === false) {
      await checkAdoptedRun();
      return false;
    }
    const r = await watchSession(null);
    if (r !== "ok" && r !== "gap") {
      await checkAdoptedRun();
      return false;
    }
    if (r === "gap") return await hubFullResync();
    if (!state.busy) {
      sweepInterruptedTools();
      flushPendingSteers();
    }
    return true;
  }
  async function hubOrphanTick() {
    const sid = state.current?.id;
    const run = state.runId;
    if (!sid || !state.busy || state.resyncing || !rpc.ready) return;
    const probe = await runIdFromInfo();
    if (state.current?.id !== sid || !state.busy || state.resyncing || state.runId !== run) return;
    if (!probe.known) return;
    if (probe.runId) {
      HUB.orphanMissAt = 0;
      if (state.runId !== probe.runId) applyActiveRunId(probe.runId);
      return;
    }
    if (!HUB.orphanMissAt) {
      HUB.orphanMissAt = performance.now();
      return;
    }
    if (performance.now() - HUB.orphanMissAt < (run || state.adopted ? 4e3 : 15e3)) return;
    HUB.orphanMissAt = 0;
    WATCH_DBG.hubOrphanFrees++;
    report("adopt", "fin del run confirmado por session/info");
    if (run || state.adopted) endRun("El turno terminó");
    else {
      systemNote("El turno anterior quedó sin cerrar (no hay run activo): se liberó la consola para seguir.");
      setBusy(false, "Sin respuesta del turno anterior");
    }
  }
  let liveRunRevision = 0;
  function applyActiveRunId(rid) {
    if (!state.hubReplay) liveRunRevision++;
    const prev = state.runId;
    if (state.hubReplay) {
      state.runId = rid || null;
      return state.runId;
    }
    if (rid) HUB.orphanMissAt = 0;
    if (rid && prev && rid !== prev && state.busy) speedStart();
    state.runId = rid || null;
    if (rid && state.busy) state.speed.runId = rid;
    if (rid) {
      if (!prev) WATCH_DBG.hubRunStarts++;
      if (!state.busy) {
        unsweepInterruptedTools();
        adoptRun(rid, ADOPTED_NOTE);
      }
      return rid;
    }
    if (!state.busy) return null;
    if (!prev && !state.adopted) {
      void hubOrphanTick();
      return null;
    }
    if (state.hubWatch === true || state.adopted) endRun("El turno terminó");
    return null;
  }
  async function activeRunId() {
    if (!rpc.ready || !state.current) return { known: false, runId: null };
    if (state.hubWatch === true) return runIdFromInfo();
    try {
      const res = await rpc.request("_aegis/unstable/session/steer", {
        sessionId: state.current.id,
        prompt: [{ type: "text", text: "." }],
        expectedRunId: "probe" + Math.random().toString(36).slice(2)
      });
      return { known: true, runId: res && res.runId || null };
    } catch (e) {
      const d = e && e.data;
      const actual = d && typeof d === "object" ? d.actualRunId : null;
      if (actual) return { known: true, runId: String(actual) };
      const dataTxt = typeof d === "string" ? d : d ? JSON.stringify(d) : "";
      const all = String(e && e.message || "") + " " + dataTxt;
      if (/no active run to steer/i.test(all)) return { known: true, runId: null };
      const mRun = all.match(/run_[0-9a-f-]{6,}/i);
      if (mRun) return { known: true, runId: mRun[0] };
      report("steer", "sondeo de run falló: " + (all.trim() || "error rpc").slice(0, 200));
      return { known: false, runId: null };
    }
  }
  function adoptRun(runId, note, startedAt) {
    state.adopted = true;
    stopOrphanWatch();
    if (runId) state.runId = runId;
    const text = note || ADOPTED_NOTE;
    if (!state.busy) setBusy(true, text, startedAt);
    else if (!$("#runbar")?.classList.contains("cancelling")) setRunBarText(text);
    startRunWatch();
  }
  function startRunWatch() {
    if (state.hubWatch === true) return;
    if (runWatch) return;
    watchSince = Date.now();
    runWatch = setInterval(watchAdoptedRun, RUN_WATCH_MS);
  }
  function stopRunWatch() {
    if (runWatch) clearInterval(runWatch);
    runWatch = 0;
    watchKey = "";
  }
  async function watchAdoptedRun() {
    const cur = state.current;
    if (!cur || !rpc.ready) return;
    if (Date.now() - watchSince > 6 * 3600 * 1e3) {
      stopRunWatch();
      return;
    }
    WATCH_DBG.ticks++;
    const probe = await activeRunId();
    if (!state.current) return;
    if (probe.known && !probe.runId) {
      stopRunWatch();
      await endAdoptedRun();
      return;
    }
    if (probe.runId && probe.runId !== state.runId) state.runId = probe.runId;
    if (!state.busy) adoptRun(probe.runId, ADOPTED_NOTE);
    const info = await rpc.request("_aegis/unstable/session/info", { sessionId: cur.id }).then((v) => {
      WATCH_DBG.infos++;
      return v;
    }).catch(() => {
      WATCH_DBG.infoErrs++;
      return null;
    });
    const meta = info && info.session && info.session._meta || {};
    const key = meta.messageCount != null ? String(meta.messageCount) + "|" + String(meta.lastMessageAt || "") : "";
    WATCH_DBG.prevKey = watchKey;
    WATCH_DBG.lastKey = key;
    WATCH_DBG.keys.push({ t: Date.now(), key, hasMeta: !!(info && info.session) });
    if (WATCH_DBG.keys.length > 40) WATCH_DBG.keys.shift();
    if (key && watchKey && key !== watchKey) {
      WATCH_DBG.resyncs++;
      await softResync(false);
    }
    if (performance.now() - lastSoftAt > softBackoffMs) await softResync(false);
    if (key) watchKey = key;
  }
  async function endAdoptedRun() {
    await softResync(true);
    state.adopted = false;
    state.runId = null;
    if (state.busy) setBusy(false, "El turno terminó (otra conexión)");
    state.suppressSettle = false;
    settleSteers();
  }
  let hotWatch = 0, hotLast = "", hotIdle = 0;
  function stopHotWatch() {
    if (hotWatch) clearInterval(hotWatch);
    hotWatch = 0;
  }
  async function hotTick() {
    const cur = state.current;
    if (!cur || !rpc.ready) {
      stopHotWatch();
      return;
    }
    const info = await rpc.request("_aegis/unstable/session/info", { sessionId: cur.id }).catch(() => null);
    const meta = info && info.session && info.session._meta || {};
    const key = String(meta.messageCount != null ? meta.messageCount : "") + "|" + String(meta.lastMessageAt || "");
    const fresh = meta.lastMessageAt ? Date.now() - Date.parse(meta.lastMessageAt) < 9e4 : false;
    if (key && key !== hotLast && hotLast) hotIdle = 0;
    else hotIdle++;
    await softResync(true);
    hotLast = key;
    WATCH_DBG.hotTicks = (WATCH_DBG.hotTicks || 0) + 1;
    if (!fresh && hotIdle > 3) {
      WATCH_DBG.hotEnds = (WATCH_DBG.hotEnds || 0) + 1;
      stopHotWatch();
      await endAdoptedRun();
    }
  }
  function startHotWatch() {
    if (hotWatch) return;
    hotIdle = 0;
    hotLast = "";
    hotWatch = setInterval(hotTick, 2500);
    hotTick();
  }
  async function resyncAdoptedRun() {
    if (state.resyncing || !state.current || !rpc.ready) return;
    const keep = {
      runId: state.runId,
      adopted: state.adopted,
      busy: state.busy,
      start: runStart,
      atts: state.attachments.slice(),
      queue: state.queue.slice(),
      steers: [...state.steers.entries()]
    };
    state.resyncing = true;
    try {
      await renderSession(state.current, { quiet: true });
    } catch (e) {
      report("error", "resync: " + e.message);
    }
    state.runId = keep.runId;
    state.adopted = keep.adopted;
    state.queue = keep.queue;
    state.steers = new Map(keep.steers);
    state.attachments = keep.atts;
    renderAttachments();
    if (keep.busy) {
      runStart = keep.start || performance.now();
      setBusy(true, ADOPTED_NOTE);
      const bar = $("#runbar");
      if (bar && bar.hidden) runBarShow(ADOPTED_NOTE);
    }
    if (keep.adopted) startRunWatch();
    state.resyncing = false;
  }
  function settleSteers(delayMs) {
    if (!state.steers.size) return;
    const snapshot = [...state.steers.entries()];
    setTimeout(() => {
      if (state.suppressSettle) return;
      finishSettle(snapshot);
    }, delayMs == null ? 2500 : delayMs);
  }
  async function finishSettle(snapshot) {
    let requeued = 0;
    for (const [mid, info] of snapshot) {
      if (!state.steers.has(mid)) continue;
      state.steers.delete(mid);
      untrackPending(mid);
      const text = info && info.text || "";
      const atts = info && info.atts || [];
      const serverHeldIt = !!(info && info.serverQueued);
      if (text && !serverHeldIt && steerAnsweredInHistory(text)) {
        if (info && info.el) info.el.classList.remove("queued");
        setQueuedNote(info, "indicación recibida por el agente");
        continue;
      }
      if (info && info.el) info.el.remove();
      if (text || atts.length) state.queue.push({ text, atts });
      requeued += 1;
    }
    if (requeued) {
      systemNote(requeued === 1 ? "Una indicación quedó sin respuesta en ese turno: se reenvía como mensaje." : requeued + " indicaciones quedaron sin respuesta: se reenvían como mensajes.");
      flushQueue();
    }
  }
  const PENDING_KEY = "gweb.pendingSteers";
  const loadPending = () => {
    try {
      return JSON.parse(localStorage.getItem(PENDING_KEY) || "[]") || [];
    } catch {
      return [];
    }
  };
  const savePending = (list) => {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-12)));
    } catch {
    }
  };
  const trackPending = (mid, text) => {
    if (!mid) return;
    savePending([...loadPending().filter((p) => p.mid !== mid), { mid, text, sessionId: state.current ? state.current.id : null, ts: Date.now() }]);
  };
  const untrackPending = (mid) => savePending(loadPending().filter((p) => p.mid !== mid));
  const wordsOf = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  function textInServerHistory(text) {
    const needle = wordsOf(text).slice(0, 60);
    if (!needle) return false;
    const box = $("#messages");
    if (!box) return false;
    const clone = box.cloneNode(true);
    clone.querySelectorAll(".msg-user.queued, .sysnote, .turn-end, .steer-note").forEach((el) => el.remove());
    return wordsOf(clone.textContent).includes(needle);
  }
  function steerAnsweredInHistory(text) {
    const needle = wordsOf(text).slice(0, 60);
    if (!needle) return false;
    const box = $("#msg-inner") || $("#messages");
    if (!box) return false;
    const nodes = [...box.querySelectorAll(".msg-user, .msg-a")];
    let lastIdx = -1;
    nodes.forEach((el, i) => {
      if (el.classList.contains("msg-user") && !el.classList.contains("queued") && wordsOf(el.textContent).includes(needle)) lastIdx = i;
    });
    if (lastIdx < 0) return false;
    for (let i = lastIdx + 1; i < nodes.length; i++) {
      if (nodes[i].classList.contains("msg-a")) return true;
    }
    return false;
  }
  function flushPendingSteers() {
    if (!state.current) return;
    const sid = state.current.id;
    const mine = loadPending().filter((p) => p.sessionId === sid);
    if (!mine.length) return;
    savePending(loadPending().filter((p) => p.sessionId !== sid));
    const stale = [];
    const seen = /* @__PURE__ */ new Set();
    for (const p of mine) {
      const text = String(p.text || "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      if (steerAnsweredInHistory(text)) {
        report("steer", "pendiente ya consumida, no se reenvia: " + text.slice(0, 40));
        continue;
      }
      stale.push(text);
    }
    if (!stale.length) return;
    for (const text of stale) state.queue.push({ text, atts: [] });
    systemNote(stale.length === 1 ? "Quedó una indicación sin respuesta del turno anterior: se reenvía como mensaje." : stale.length + " indicaciones quedaron sin respuesta: se reenvían como mensajes.");
    flushQueue();
  }
  async function checkAdoptedRun() {
    if (!rpc.ready || !state.current) return false;
    state.suppressSettle = false;
    const probe = await activeRunId();
    if (!state.current) return false;
    if (probe.known && probe.runId) {
      unsweepInterruptedTools();
      adoptRun(probe.runId, "Turno en curso (seguía corriendo al recargar)");
      systemNote("Este turno ya estaba en curso cuando abriste la página: se sigue con refresco periódico (el streaming en vivo va a la conexión que lo arrancó).");
      return true;
    }
    stopRunWatch();
    if (!(probe.known && probe.runId)) {
      const _m = await rpc.request("_aegis/unstable/session/info", { sessionId: state.current.id }).then((v) => v && v.session && v.session._meta || {}).catch(() => ({}));
      const _fresh = _m.lastMessageAt ? Date.now() - Date.parse(_m.lastMessageAt) < 15e4 : false;
      if (_fresh) {
        unsweepInterruptedTools();
        if (!state.busy) setBusy(true, "Turno en curso (recuperado tras recargar)");
        startHotWatch();
        return true;
      }
    }
    sweepInterruptedTools();
    if (!state.busy) flushPendingSteers();
    return false;
  }
  function leerCacheChips() {
    try {
      const j = JSON.parse(localStorage.getItem("aegis.chipCache") || "[]");
      return Array.isArray(j) ? j : [];
    } catch (e) {
      return [];
    }
  }
  function guardarCacheChips(opts) {
    try {
      localStorage.setItem("aegis.chipCache", JSON.stringify((opts || []).slice(0, 8)));
    } catch (e) {
    }
  }
  function leerPendientes() {
    try {
      const j = JSON.parse(localStorage.getItem("aegis.pendingConfig") || "{}");
      return j && typeof j === "object" ? j : {};
    } catch (e) {
      return {};
    }
  }
  function guardarPendientes() {
    try {
      localStorage.setItem("aegis.pendingConfig", JSON.stringify(state.pendingConfig || {}));
    } catch (e) {
    }
  }
  async function aplicarPendientes(sessionId) {
    const pend = state.pendingConfig || {};
    const ids = Object.keys(pend);
    if (!ids.length) return;
    const ordered = ids.sort((a, b) => a === "provider" ? -1 : b === "provider" ? 1 : 0);
    for (const configId of ordered) {
      try {
        const res = await rpc.request("session/set_config_option", { sessionId, configId, value: pend[configId] });
        if (res && Array.isArray(res.configOptions) && state.current) state.current.configOptions = res.configOptions;
      } catch (e) {
        systemNote("No se pudo aplicar «" + configId + "» elegido antes de crear el chat: " + (e && e.message ? e.message : e));
      }
    }
    const quedo = {};
    for (const o of state.current && state.current.configOptions || []) {
      if (o && o.id) quedo[o.id] = o.currentValue;
    }
    const sinAplicar = ids.filter((id) => {
      if (quedo[id] === void 0 || quedo[id] === pend[id]) return false;
      const opcion = (state.current && state.current.configOptions || []).find((o) => o && o.id === id);
      const etiqueta = opcion && Array.isArray(opcion.options) ? (opcion.options.find((o) => o.value === pend[id]) || {}).name || "" : "";
      return !/default/i.test(etiqueta);
    });
    if (sinAplicar.length) {
      systemNote(
        "Ojo: la elección hecha antes de crear el chat no quedó aplicada (" + sinAplicar.join(", ") + "). Cambiala con los selectores de arriba, ya con el chat abierto."
      );
    }
    state.pendingConfig = {};
    guardarPendientes();
    renderChips();
  }
  function etiquetaOpcion(o) {
    const bruto = String(o && (o.name || o.value) || "");
    if (!bruto || bruto.indexOf("_") === -1) return bruto;
    return bruto.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
  const LEGACY_MODEL = /^(deepseek-v4\.1-flash|glm-5\.3-flash|gemini-3\.8-flash)-(none|low|medium|high|max)$/;
  const migradas = /* @__PURE__ */ new Set();
  let migrando = false;
  function migrarModeloViejo() {
    const cur = state.current;
    if (!cur || migrando || migradas.has(cur.id)) return;
    const opts = cur.configOptions || [];
    const modelOpt = opts.find((o) => o && o.id === "model");
    if (!modelOpt) return;
    const valor = String(modelOpt.currentValue || "");
    const m = LEGACY_MODEL.exec(valor);
    if (!m) return;
    const base = m[1];
    const esfuerzo = m[2] === "none" ? "off" : m[2];
    if (!(modelOpt.options || []).some((o) => o && o.value === base)) return;
    migrando = true;
    migradas.add(cur.id);
    rpc.request("session/set_config_option", { sessionId: cur.id, configId: "model", value: base }).then((r) => {
      if (r && Array.isArray(r.configOptions)) cur.configOptions = r.configOptions;
      const effortOpt = (cur.configOptions || []).find((o) => o && o.id === "thinking_effort");
      if (!effortOpt || !(effortOpt.options || []).some((o) => o && o.value === esfuerzo)) return null;
      return rpc.request("session/set_config_option", { sessionId: cur.id, configId: "thinking_effort", value: esfuerzo });
    }).then((r) => {
      if (r && Array.isArray(r.configOptions)) cur.configOptions = r.configOptions;
      renderChips();
    }).catch(() => {
    }).finally(() => {
      migrando = false;
    });
  }
  function renderChips() {
    const wrap = $("#chips");
    wrap.innerHTML = "";
    document.querySelectorAll("body > .menu").forEach((m) => m.remove());
    const deLaSesion = state.current && Array.isArray(state.current.configOptions) && state.current.configOptions.length ? state.current.configOptions : null;
    if (deLaSesion) guardarCacheChips(deLaSesion);
    const opts = deLaSesion || leerCacheChips();
    const providerOpt = opts.find((o) => o && o.id === "provider");
    if (!deLaSesion && providerOpt && !providerOpt.options.some((o) => o.value === "opencode_go")) {
      providerOpt.options.push({ value: "opencode_go", name: "OpenCode Go" });
    }
    for (const opt of opts) {
      if (opt.type !== "select" || !Array.isArray(opt.options) || opt.options.length <= 1) continue;
      const item = document.createElement("div");
      item.className = "chip-wrap";
      item.dataset.opt = opt.id;
      const btn = document.createElement("button");
      btn.className = "chip";
      const cur = opt.options.find((o) => o.value === opt.currentValue) || opt.options[0];
      btn.textContent = cur && (cur.name || cur.value) || opt.name || opt.id;
      btn.title = opt.name || opt.id;
      const menu = document.createElement("div");
      menu.className = "menu";
      menu.hidden = true;
      menu.innerHTML = `<div class="menu-label">${esc(opt.name || opt.id)}</div>`;
      for (const o of opt.options) {
        const row = document.createElement("button");
        row.className = "menu-row" + (o.value === opt.currentValue ? " sel" : "");
        row.innerHTML = `<span>${esc(etiquetaOpcion(o))}</span>`;
        row.addEventListener("click", async (e) => {
          e.stopPropagation();
          menu.hidden = true;
          await setConfig(opt.id, o.value);
        });
        menu.appendChild(row);
      }
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasHidden = menu.hidden;
        closeMenus();
        if (wasHidden) openMenu(btn, menu);
      });
      item.append(btn, menu);
      wrap.appendChild(item);
    }
    const dwrap = document.createElement("div");
    dwrap.className = "chip-wrap";
    const dbtn = document.createElement("button");
    dbtn.id = "btn-debate";
    dbtn.type = "button";
    dbtn.className = "chip debate-chip";
    dbtn.addEventListener("click", function(e) {
      e.stopPropagation();
      debateToggle();
    });
    dwrap.appendChild(dbtn);
    wrap.appendChild(dwrap);
    debateSyncBtn();
    migrarModeloViejo();
  }
  function openMenu(btn, menu) {
    const r = btn.getBoundingClientRect();
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    menu.hidden = false;
    const h = menu.offsetHeight;
    let top = r.bottom + 7;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 7);
    menu.style.top = Math.round(top) + "px";
    const anchoMenu = menu.offsetWidth;
    const margen = 8;
    let left = r.right - anchoMenu;
    if (left < margen) left = margen;
    if (left + anchoMenu > window.innerWidth - margen) left = Math.max(margen, window.innerWidth - margen - anchoMenu);
    menu.style.left = Math.round(left) + "px";
    menu.style.right = "auto";
    menuOpenedAt = Date.now();
  }
  let menuOpenedAt = 0;
  const closeMenus = () => document.querySelectorAll(".menu").forEach((m) => m.hidden = true);
  document.addEventListener("click", closeMenus);
  window.addEventListener("resize", closeMenus);
  window.addEventListener(
    "scroll",
    (e) => {
      if (e.target && e.target.closest && e.target.closest(".menu")) return;
      if (Date.now() - menuOpenedAt < 500) return;
      closeMenus();
    },
    true
  );
  async function setConfig(configId, value) {
    if (!state.current) {
      state.pendingConfig = state.pendingConfig || {};
      state.pendingConfig[configId] = value;
      guardarPendientes();
      const cache = leerCacheChips();
      const opt = cache.find((o) => o && o.id === configId);
      if (opt) {
        opt.currentValue = value;
        guardarCacheChips(cache);
      }
      if (configId === "provider") {
        delete state.pendingConfig.model;
        guardarPendientes();
        const model = cache.find((o) => o && o.id === "model");
        if (model) {
          model.options = [];
          model.currentValue = "";
        }
        guardarCacheChips(cache);
      }
      renderChips();
      return;
    }
    try {
      const res = await rpc.request("session/set_config_option", { sessionId: state.current.id, configId, value });
      if (res && Array.isArray(res.configOptions)) state.current.configOptions = res.configOptions;
      renderChips();
      refreshSessions();
    } catch (e) {
      systemNote("No se pudo cambiar «" + configId + "»: " + e.message);
    }
  }
  function renderAttachments() {
    const box = $("#attachments");
    box.innerHTML = "";
    if (!state.attachments.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    state.attachments.forEach((a, i) => {
      const d = document.createElement("div");
      if (a.kind === "text") {
        d.className = "att-file";
        d.innerHTML = `<span class="att-file-ic">📄</span><div class="att-file-body"><div class="att-file-name" title="${esc(a.name)}">${esc(a.name)}</div><div class="att-file-size">${fmtSize(a.size)} · texto</div></div><button class="att-x" aria-label="Quitar">✕</button>`;
      } else {
        d.className = "att-thumb";
        d.innerHTML = `<img src="${a.url}" alt="${esc(a.name || "adjunto")}"><button class="att-x" aria-label="Quitar">✕</button>`;
      }
      d.querySelector(".att-x").addEventListener("click", () => {
        state.attachments.splice(i, 1);
        renderAttachments();
      });
      box.appendChild(d);
    });
  }
  const MAX_ATTACH = 6;
  const MAX_IMAGE = 12 * 1024 * 1024;
  const MAX_TEXT_FILE = 256 * 1024;
  const MAX_TEXT_CHARS = 8e4;
  const TEXT_EXT = /\.(txt|text|md|markdown|json|jsonl|csv|tsv|log|yml|yaml|toml|ini|cfg|conf|env|sh|bash|zsh|ps1|bat|cmd|js|mjs|cjs|ts|tsx|jsx|py|rs|go|rb|php|java|kt|kts|c|h|cpp|hpp|cc|cs|swift|sql|html|htm|css|scss|less|xml|svg|diff|patch|recipe|yaml)$/i;
  const isTextFile = (f) => /^text\//.test(f.type || "") || TEXT_EXT.test(f.name || "") || /(^|[\\/])(dockerfile|makefile|readme|license)$/i.test(f.name || "");
  const loadImg = (src) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
  async function fileToAttachment(file) {
    if (!/^image\//.test(file.type || "")) return null;
    if (file.size > MAX_IMAGE) {
      systemNote("Imagen demasiado grande (máx 12 MB).");
      return null;
    }
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(new Error("no se pudo leer el archivo"));
      fr.readAsDataURL(file);
    });
    let mime = (dataUrl.match(/^data:([^;]+)/) || [])[1] || file.type || "image/png";
    let b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    try {
      const img = await loadImg(dataUrl);
      const maxDim = 1800;
      if (img.width > maxDim || img.height > maxDim || b64.length > 26e5) {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        const outMime = mime === "image/png" && b64.length < 12e5 ? "image/png" : "image/jpeg";
        const out = canvas.toDataURL(outMime, 0.85);
        mime = outMime;
        b64 = out.slice(out.indexOf(",") + 1);
      }
    } catch {
    }
    return { mimeType: mime, data: b64, url: "data:" + mime + ";base64," + b64 };
  }
  async function fileToTextAttachment(file) {
    if (file.size > MAX_TEXT_FILE) {
      systemNote(`«${file.name}» es muy grande para adjuntar como texto (máx 256 KB).`);
      return null;
    }
    let text = "";
    try {
      text = await file.text();
    } catch {
      return null;
    }
    let clipped = false;
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
      clipped = true;
    }
    const size = file.size || text.length;
    return {
      kind: "text",
      name: file.name || "archivo.txt",
      size,
      text: clipped ? text + `
… (recortado: solo se enviaron los primeros ${MAX_TEXT_CHARS} caracteres de ${size} bytes)` : text
    };
  }
  async function addFiles(files) {
    const list = [...files || []];
    if (!list.length) return;
    let rejected = 0;
    for (const f of list) {
      if (state.attachments.length >= MAX_ATTACH) {
        systemNote(`Máximo ${MAX_ATTACH} adjuntos por mensaje.`);
        break;
      }
      let att = null;
      try {
        if (/^image\//.test(f.type || "")) att = await fileToAttachment(f);
        else if (isTextFile(f)) att = await fileToTextAttachment(f);
        else rejected++;
      } catch {
        rejected++;
      }
      if (att) state.attachments.push(att);
    }
    if (rejected === 1) systemNote("Solo puedo adjuntar imágenes o archivos de texto.");
    else if (rejected > 1) systemNote(`No adjunté ${rejected} archivos: solo imágenes o texto.`);
    renderAttachments();
  }
  function wireDropzone() {
    const dz = $("#dropzone");
    const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));
    let depth = 0;
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      dz.hidden = false;
    });
    window.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) dz.hidden = true;
    });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      dz.hidden = true;
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) {
        closeDrawer();
        addFiles(files);
      }
    });
  }
  const slashQuery = () => {
    const v = $("#input").value;
    if (!v.startsWith("/")) return null;
    const m = /^\/([^\s]*)$/.exec(v);
    return m ? m[1] : null;
  };
  async function ensureSlashCommands() {
    if (state.slashLoaded || state.slashLoading || !rpc.ready) return;
    state.slashLoading = true;
    try {
      const res = await rpc.request("_aegis/unstable/slash-commands/list", {
        cwd: CFG.cwd || void 0,
        sessionId: state.current && state.current.id || void 0
      });
      state.slash = res && res.availableCommands || [];
      state.slashLoaded = true;
    } catch (e) {
      report("error", "slash-commands/list: " + e.message);
      state.slashLoaded = true;
    }
    state.slashLoading = false;
    refreshSlashMenu();
    updateMetaHints();
  }
  function refreshSlashMenu() {
    const box = $("#slash-menu");
    if (!box) return;
    const q = slashQuery();
    if (q === null) {
      box.hidden = true;
      state.slashItems = [];
      return;
    }
    if (!state.slashLoaded) ensureSlashCommands();
    const needle = q.toLowerCase();
    state.slashItems = state.slash.filter((c) => !needle || String(c.name || "").toLowerCase().includes(needle)).slice(0, 40);
    const head = `<div class="slash-head"><span>Comandos</span><span>↑↓ · Tab/Enter inserta · Esc cierra</span></div>`;
    box.hidden = false;
    if (!state.slashItems.length) {
      box.innerHTML = head + `<div class="slash-hint">${state.slashLoaded ? `Ningún comando coincide con «/${esc(q)}».` : "Cargando comandos…"}</div>`;
      return;
    }
    if (state.slashIdx >= state.slashItems.length) state.slashIdx = 0;
    box.innerHTML = head + state.slashItems.map((c, i) => {
      const type = c._meta && (c._meta.commandType || c._meta.type) || "";
      const hint = c.input && c.input.hint ? " · " + c.input.hint : "";
      return `<button class="slash-item${i === state.slashIdx ? " sel" : ""}" type="button" data-i="${i}"><span class="slash-name">/${esc(c.name)}</span><span class="slash-desc">${esc((c.description || "") + hint)}</span>` + (type ? `<span class="slash-type">${esc(type)}</span>` : "") + `</button>`;
    }).join("");
    const sel = box.querySelector(".slash-item.sel");
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
  }
  function insertSlash(cmd) {
    if (!cmd) return;
    const input = $("#input");
    input.value = "/" + cmd.name + " ";
    autosize();
    $("#slash-menu").hidden = true;
    input.focus();
  }
  function slashKey(e) {
    const box = $("#slash-menu");
    if (!box || box.hidden) return false;
    if (e.key === "Escape") {
      box.hidden = true;
      return true;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!state.slashItems.length) return false;
      e.preventDefault();
      const n = state.slashItems.length;
      state.slashIdx = (state.slashIdx + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      refreshSlashMenu();
      return true;
    }
    if (e.key === "Tab" || e.key === "Enter" && !e.shiftKey) {
      if (!state.slashItems.length) return false;
      e.preventDefault();
      insertSlash(state.slashItems[state.slashIdx]);
      return true;
    }
    return false;
  }
  function updateTitle() {
    $("#chat-title").textContent = state.current && state.current.title || "Nuevo chat";
    document.title = (state.current && state.current.title || "Aegis") + " · Aegis web";
  }
  function setStatus(kind, text) {
    const dot = $("#conn-dot");
    dot.className = "dot" + (kind ? " " + kind : "");
    $("#conn-text").textContent = text;
  }
  const openDrawer = () => {
    $("#sidebar").classList.add("open");
    $("#overlay").hidden = false;
  };
  const closeDrawer = () => {
    $("#sidebar").classList.remove("open");
    $("#overlay").hidden = true;
  };
  let composing = false;
  let composerRaf = 0;
  let lastComposerValue = null;
  const FIELD_SIZING = typeof CSS !== "undefined" && CSS.supports && CSS.supports("field-sizing", "content");
  let lastSizeAt = 0;
  let lastComposerLines = -1;
  function autosize(force) {
    const t = $("#input");
    lastComposerValue = t.value;
    if (FIELD_SIZING) return;
    const now = performance.now();
    const lines = (t.value.match(/\n/g) || []).length;
    if (!force && lines === lastComposerLines && now - lastSizeAt < 120) return;
    lastComposerLines = lines;
    lastSizeAt = now;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 200) + "px";
  }
  function scheduleComposer() {
    if (composerRaf) return;
    composerRaf = requestAnimationFrame(() => {
      composerRaf = 0;
      const t = $("#input");
      if (t.value === lastComposerValue) return;
      const previo = lastComposerValue || "";
      lastComposerValue = t.value;
      const t0 = performance.now();
      autosize();
      if (t.value.charAt(0) === "/" || previo.charAt(0) === "/") refreshSlashMenu();
      const dt = performance.now() - t0;
      METRICS.composerRuns++;
      METRICS.composerMs += dt;
      if (dt > METRICS.maxComposerMs) METRICS.maxComposerMs = dt;
    });
  }
  async function onBoot() {
    $("#conn-host").textContent = CFG.host || "";
    renderChips();
    updateMetaHints();
    resetUsageForSession();
    await refreshSessions();
    const last = localStorage.getItem("gweb.last");
    const entry = findSession(last);
    if (entry) await openSession(entry);
    else {
      clearMessages();
      showWelcome("new");
      await checkAdoptedRun();
    }
    refreshSlashMenu();
    report("boot", "ok - sesiones=" + state.sessions.length + " archivadas=" + state.archived.length + " adoptado=" + state.adopted);
  }
  const CHAT_FONT_KEY = "aegis.chatFontPx";
  const CHAT_FONT_DEFAULT = 16;
  function validChatFont(raw) {
    if (raw === null || !/^(?:[2-9]|1[0-9]|2[0-2])$/.test(raw)) return CHAT_FONT_DEFAULT;
    return Number(raw);
  }
  let chatFont = CHAT_FONT_DEFAULT;
  try {
    chatFont = validChatFont(localStorage.getItem(CHAT_FONT_KEY));
  } catch {
  }
  function setChatFont(px) {
    chatFont = Math.max(2, Math.min(22, Math.round(px)));
    const messages = $("#messages");
    if (messages) {
      const scale = chatFont / CHAT_FONT_DEFAULT;
      messages.classList.toggle("chat-compact", chatFont <= 10);
      messages.style.setProperty("--chat-space-scale", String(Math.max(0.35, Math.min(1.25, scale))));
      const sizes = {
        "--chat-font": chatFont,
        "--chat-user-font": 14.5 * scale,
        "--chat-small-font": 12.5 * scale,
        "--chat-h3-font": 18 * scale,
        "--chat-h4-font": 16.5 * scale,
        "--chat-h5-font": 15 * scale,
        "--chat-thought-font": 13.5 * scale,
        "--chat-table-label-font": 11 * scale,
        "--chat-tool-output-font": 11.5 * scale,
        "--chat-tool-name-font": 12 * scale,
        "--chat-permission-font": 13.5 * scale
      };
      for (const [name, size] of Object.entries(sizes)) messages.style.setProperty(name, size + "px");
    }
    const range = $("#chat-font-range");
    if (range) range.value = String(chatFont);
    const value = $("#chat-font-value");
    if (value) value.textContent = chatFont + " px";
    try {
      localStorage.setItem(CHAT_FONT_KEY, String(chatFont));
    } catch {
    }
  }
  function wireChatFont() {
    setChatFont(chatFont);
    const pop = $("#chat-font-pop");
    const button = $("#btn-chat-font");
    button.addEventListener("click", () => {
      pop.hidden = !pop.hidden;
      button.setAttribute("aria-expanded", String(!pop.hidden));
    });
    $("#chat-font-range").addEventListener("input", (e) => setChatFont(Number(e.target.value)));
    $("#chat-font-minus").addEventListener("click", () => setChatFont(chatFont - 1));
    $("#chat-font-plus").addEventListener("click", () => setChatFont(chatFont + 1));
    $("#chat-font-reset").addEventListener("click", () => setChatFont(CHAT_FONT_DEFAULT));
    document.addEventListener("pointerdown", (e) => {
      if (!pop.hidden && !pop.contains(e.target) && !button.contains(e.target)) {
        pop.hidden = true;
        button.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !pop.hidden) {
        pop.hidden = true;
        button.setAttribute("aria-expanded", "false");
        button.focus();
      }
    });
  }
  function wire() {
    wireChatFont();
    $("#messages").addEventListener("click", (e) => {
      const cc = e.target.closest(".copy-code");
      if (cc) {
        const code = cc.parentElement.querySelector("pre code");
        copyText(code ? code.textContent : "").then((ok) => {
          cc.textContent = ok ? "✓ Copiado" : "No se pudo";
          cc.classList.add("done");
          setTimeout(() => {
            cc.textContent = "Copiar";
            cc.classList.remove("done");
          }, 1400);
        });
        return;
      }
      const mc = e.target.closest(".msg-copy");
      if (mc) {
        const el = mc.parentElement.cloneNode(true);
        el.querySelectorAll("button").forEach((b) => b.remove());
        copyText(el.innerText || el.textContent || "").then((ok) => {
          mc.textContent = ok ? "✓" : "No";
          mc.classList.add("done");
          setTimeout(() => {
            mc.textContent = "Copiar";
            mc.classList.remove("done");
          }, 1400);
        });
        return;
      }
      const th = e.target.closest(".thought");
      if (th) {
        th.classList.toggle("open");
        return;
      }
      const tool = e.target.closest(".tool.has-content");
      if (tool) tool.classList.toggle("open");
    });
    $("#btn-new").addEventListener("click", () => newSession());
    $("#btn-menu").addEventListener("click", openDrawer);
    $("#overlay").addEventListener("click", closeDrawer);
    $("#btn-close-drawer").addEventListener("click", closeDrawer);
    $("#btn-send").addEventListener("click", send);
    $("#btn-stop").addEventListener("click", stopRun);
    const rb = $("#btn-read");
    if (rb) rb.addEventListener("click", () => readToggle());
    const corta = () => readReset(true);
    $("#btn-send").addEventListener("click", corta);
    $("#btn-stop").addEventListener("click", corta);
    readSyncBtn();
    const input = $("#input");
    input.addEventListener("input", () => {
      lastTypedAt = performance.now();
      if (!composing) scheduleComposer();
    });
    input.addEventListener("compositionstart", () => {
      composing = true;
    });
    input.addEventListener("compositionend", () => {
      composing = false;
      lastComposerValue = null;
      lastTypedAt = performance.now();
      scheduleComposer();
    });
    input.addEventListener("keydown", (e) => {
      lastTypedAt = performance.now();
      if (slashKey(e)) return;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !composing && e.keyCode !== 229) {
        e.preventDefault();
        send();
      }
    });
    input.addEventListener("paste", (e) => {
      const items = e.clipboardData && e.clipboardData.items || [];
      const files = [];
      for (const it of items) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });
    $("#btn-attach").addEventListener("click", () => $("#file-input").click());
    $("#file-input").addEventListener("change", (e) => {
      addFiles([...e.target.files]);
      e.target.value = "";
    });
    $("#search").addEventListener("input", (e) => {
      state.filter = e.target.value;
      renderList();
    });
    $("#slash-menu").addEventListener("click", (e) => {
      const it = e.target.closest(".slash-item");
      if (!it) return;
      insertSlash(state.slashItems[Number(it.dataset.i)]);
    });
    $("#session-list").addEventListener("click", (e) => {
      const more = e.target.closest(".sb-more-btn");
      if (more) {
        e.stopPropagation();
        loadMoreSessions();
        return;
      }
      const arch = e.target.closest(".sb-arch-toggle");
      if (arch) {
        e.stopPropagation();
        state.showArchived = !state.showArchived;
        renderList();
        return;
      }
      const menu = e.target.closest(".sb-more");
      if (menu) {
        e.stopPropagation();
        const row = menu.closest(".sb-row");
        openRowMenu(menu, row.dataset.id, row.dataset.arch === "1");
        return;
      }
      const ren = e.target.closest(".sb-rename");
      if (ren) {
        e.stopPropagation();
        startRename(ren.closest(".sb-row").dataset.id);
        return;
      }
      const del = e.target.closest(".sb-del");
      if (del) {
        e.stopPropagation();
        askDelete(del.closest(".sb-row").dataset.id);
        return;
      }
      const item = e.target.closest(".sb-item");
      if (!item) return;
      const id = item.parentElement.dataset.id;
      const entry = findSession(id);
      if (entry && (!state.current || state.current.id !== id)) openSession(entry);
      else closeDrawer();
    });
    document.querySelectorAll(".sug").forEach(
      (b) => b.addEventListener("click", () => {
        input.value = b.textContent;
        input.focus();
        autosize();
      })
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeMenus();
        closeRowMenus();
        const sm = $("#slash-menu");
        if (sm && !sm.hidden) {
          sm.hidden = true;
          return;
        }
        if ($("#sidebar").classList.contains("open")) closeDrawer();
      }
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "k") {
        e.preventDefault();
        const sb = $("#sidebar");
        if (window.innerWidth <= 880 && !sb.classList.contains("open")) openDrawer();
        $("#search").focus();
        $("#search").select();
      }
    });
    window.addEventListener("resize", autosize);
    wireDropzone();
  }
  var READ_ON = false;
  function readKeyFor(id) {
    return "aegis.readOn." + (id || "nuevo");
  }
  function readLoad() {
    readReset(true);
    try {
      var id = state.current && state.current.id;
      var v = localStorage.getItem(readKeyFor(id));
      if (v === null) {
        var viejo = localStorage.getItem("aegis.readOn");
        if (viejo !== null) {
          v = viejo === "1" ? "1" : "0";
          localStorage.setItem(readKeyFor(id), v);
          localStorage.removeItem("aegis.readOn");
        } else {
          v = "0";
        }
      }
      READ_ON = v === "1";
    } catch (e) {
      READ_ON = false;
    }
    readSyncBtn();
    return READ_ON;
  }
  try {
    READ_ON = localStorage.getItem(readKeyFor(null)) === "1";
  } catch (e) {
  }
  var READ = { key: null, consumed: 0, spoken: 0, rate: 1.02, voice: null, engine: "piper", voiceName: "es_AR-daniela-high", fallos: 0 };
  try {
    if (localStorage.getItem("aegis.ttsEngine") !== "piper") localStorage.removeItem("aegis.ttsEngine");
    localStorage.removeItem("aegis.ttsVoice");
  } catch (e) {
  }
  function readVoicePick() {
    try {
      var vs = window.speechSynthesis.getVoices() || [];
      if (!vs.length) return;
      var es = vs.filter(function(v) {
        return /^es/i.test(v.lang || "");
      });
      READ.voice = es[0] || vs[0] || null;
    } catch (e) {
    }
  }
  var AUD = { q: [], playing: false, cur: null, pre: null };
  function audPrefetch() {
    if (AUD.pre || !AUD.q.length) return;
    var t = AUD.q[0];
    var a = new Audio(ttsUrlFor(READ.voiceName, t));
    a.preload = "auto";
    try {
      a.load();
    } catch (e) {
    }
    AUD.pre = { t, a };
  }
  function audNext() {
    if (AUD.playing || !AUD.q.length) return;
    var t = AUD.q[0];
    var a = AUD.pre && AUD.pre.t === t ? AUD.pre.a : null;
    AUD.pre = null;
    AUD.q.shift();
    AUD.playing = true;
    a = a || new Audio(ttsUrlFor(READ.voiceName, t));
    AUD.cur = a;
    var segir = function() {
      AUD.playing = false;
      AUD.cur = null;
      audNext();
      if (!AUD.playing && !AUD.q.length) handsFreeMaybe();
    };
    var fallar = function() {
      if (AUD.cur === a) {
        AUD.playing = false;
        AUD.cur = null;
      }
      READ.fallos = (READ.fallos || 0) + 1;
      try {
        console.warn("lectura: fallo el audio de Piper (intento " + READ.fallos + ")");
      } catch (e) {
      }
      if (READ.fallos === 1) systemNote("No pude pedirle el audio al server (¿está encendido?). Sigo mudo: la voz del teléfono quedó desactivada.");
      audNext();
    };
    a.onended = segir;
    a.onerror = fallar;
    var pr = a.play();
    if (pr && pr.catch) pr.catch(fallar);
    audPrefetch();
  }
  function audStop() {
    AUD.q.length = 0;
    if (AUD.cur) {
      try {
        AUD.cur.pause();
      } catch (e) {
      }
      AUD.cur = null;
    }
    AUD.pre = null;
    AUD.playing = false;
  }
  function readSay(text) {
    var t = String(text || "").trim();
    if (!t) return;
    var btn = document.getElementById("btn-read");
    if (btn) btn.classList.add("speaking");
    AUD.q.push(t);
    audNext();
    audPrefetch();
  }
  function readReset(cancelar) {
    audStop();
    READ.spoken = 0;
    READ.key = null;
    try {
      if (cancelar && window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (e) {
    }
    var btn = document.getElementById("btn-read");
    if (btn) btn.classList.remove("speaking");
  }
  function readPump(key, rawText, final) {
    if (!READ_ON) return;
    if (READ.key !== key) {
      READ.key = key;
      READ.consumed = 0;
    }
    READ.lastKey = key;
    READ.lastRaw = rawText;
    var raw = readBlock(rawText);
    if (!raw) return;
    var done = READ.consumed || 0;
    if (raw.length <= done) return;
    var pend = raw.slice(done);
    var cortes = [], mm;
    var reCut = /[.!?…](?=\s|$)/g;
    while (mm = reCut.exec(pend)) cortes.push(mm.index + 1);
    var LIMITE = 260;
    var cut = -1;
    if (done === 0 && cortes.length) {
      cut = cortes[0];
    } else {
      for (var i = 0; i < cortes.length; i++) if (cortes[i] <= LIMITE) cut = cortes[i];
      if (cut < 0) {
        if (cortes.length) cut = cortes[0];
        else if (final) cut = pend.length;
        else if (pend.length > LIMITE + 60 && pend.indexOf(" ") > 0) cut = pend.lastIndexOf(" ");
        else return;
      }
    }
    var trozo = readClean(pend.slice(0, cut));
    READ.consumed = done + cut;
    if (trozo.length > 2) readSay(trozo);
  }
  function readFlush() {
    if (!READ_ON || !READ.lastKey) return;
    readPump(READ.lastKey, READ.lastRaw || "", true);
  }
  function readToggle(force) {
    READ_ON = force === void 0 ? !READ_ON : !!force;
    try {
      localStorage.setItem(readKeyFor(state.current && state.current.id), READ_ON ? "1" : "0");
    } catch (e) {
    }
    var btn = document.getElementById("btn-read");
    if (btn) {
      btn.classList.toggle("on", READ_ON);
      btn.title = READ_ON ? "Lectura en voz alta ENCENDIDA: se lee el bloque «Para escuchar» en vivo. Tocá para apagar." : "Leer en voz alta: lee SOLO el bloque «Para escuchar» de cada respuesta, en vivo mientras llega";
    }
    if (!READ_ON) readReset(true);
    else {
      readVoicePick();
      readReset(true);
    }
    readSyncBtn();
    systemNote(READ_ON ? "Lectura en voz alta encendida." : "Lectura en voz alta apagada.");
    return READ_ON;
  }
  function readSyncBtn() {
    var b = document.getElementById("btn-read");
    if (!b) return false;
    b.classList.toggle("on", READ_ON);
    b.title = READ_ON ? "Lectura en voz alta ENCENDIDA: se lee el bloque «Para escuchar» en vivo. Tocá para apagar." : "Leer en voz alta: lee SOLO el bloque «Para escuchar» de cada respuesta, en vivo mientras llega";
    if (READ_ON) readVoicePick();
    try {
      if (window.speechSynthesis) window.speechSynthesis.addEventListener("voiceschanged", readVoicePick);
    } catch (e) {
    }
    return true;
  }
  if (!readSyncBtn()) document.addEventListener("DOMContentLoaded", readSyncBtn, { once: true });
  var draftTimer = 0;
  var lastListPoll = 0;
  function draftKey(id) {
    return "aegis.draft." + (id || "nuevo");
  }
  function saveDraft() {
    try {
      var el = document.getElementById("input");
      if (!el) return;
      var k = draftKey(state.current && state.current.id);
      if (el.value && el.value.trim()) localStorage.setItem(k, el.value);
      else localStorage.removeItem(k);
    } catch (e) {
    }
  }
  function loadDraft() {
    try {
      var el = document.getElementById("input");
      if (!el) return;
      el.value = localStorage.getItem(draftKey(state.current && state.current.id)) || "";
      autosize();
      refreshSlashMenu();
    } catch (e) {
    }
  }
  function wireDraft() {
    var el = document.getElementById("input");
    if (!el) return false;
    el.addEventListener("input", function() {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(saveDraft, 400);
    });
    el.addEventListener("blur", saveDraft);
    window.addEventListener("beforeunload", saveDraft);
    document.addEventListener("visibilitychange", function() {
      if (document.visibilityState === "hidden") saveDraft();
    });
    window.addEventListener("focus", function() {
      try {
        document.title = String(document.title).replace(/^([\u2714\u2705]\s*)/, "");
      } catch (e) {
      }
    });
    return true;
  }
  var liveRuns = /* @__PURE__ */ new Map();
  function markRun(sid, on) {
    if (!sid) return;
    var current = liveRuns.get(sid);
    if (on) {
      if (current && !current.doneT) return;
      liveRuns.set(sid, { t0: Date.now(), doneT: 0 });
    } else {
      if (current && current.doneT) return;
      var prev = current || { t0: 0 };
      liveRuns.set(sid, { t0: prev.t0 || 0, doneT: Date.now() });
      var enOtraVista = !(state.current && state.current.id === sid);
      if (enOtraVista) {
        var s = (state.sessions || []).filter(function(x) {
          return x.sessionId === sid;
        })[0];
        var titulo = s && s.title || "chat " + String(sid).slice(0, 8);
        systemNote("Terminó: " + titulo + ".");
        try {
          document.title = "✔ " + String(document.title).replace(/^\u2714\s*/, "");
        } catch (e) {
        }
      }
    }
    try {
      renderList();
    } catch (e) {
    }
  }
  function isRunning(id) {
    if (state.runningIds && state.runningIds.has(id)) return true;
    var r = liveRuns.get(id);
    return !!(r && !r.doneT);
  }
  function isDoneRecently(id) {
    var r = liveRuns.get(id);
    return !!(r && r.doneT && Date.now() - r.doneT < 9e4);
  }
  function anyRunning() {
    if (state.runningIds && state.runningIds.size) return true;
    var hay = false;
    liveRuns.forEach(function(v) {
      if (!v.doneT) hay = true;
    });
    return hay;
  }
  document.addEventListener("click", function(ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest(".msg-read") : null;
    if (!b) return;
    var msg = b.closest(".msg-a");
    var rec = msg && msg.__rec;
    if (!rec) return;
    var limpio = readClean(readBlock(rec.text));
    if (!limpio) return;
    var partes = [];
    var re = /[^.!?\u2026]+[.!?\u2026]*/g, m;
    while (m = re.exec(limpio)) {
      var p = m[0].trim();
      if (p.length > 2) partes.push(p);
    }
    if (!partes.length) return;
    audStop();
    for (const parte of partes) AUD.q.push(parte);
    audNext();
  });
  if (!wireDraft()) document.addEventListener("DOMContentLoaded", wireDraft, { once: true });
  async function fetchGoals(forzar) {
    const sid = state.current && state.current.id || "";
    if (!sid) {
      state.goals = [];
      state.goalsErr = "";
      renderGoals();
      return;
    }
    if (!forzar && state.goalsSid === sid && state.goalsAt && Date.now() - state.goalsAt < 2e4) return;
    state.goalsSid = sid;
    state.goalsAt = Date.now();
    try {
      const r = await fetch("/goals.json?sid=" + encodeURIComponent(sid), { cache: "no-store" });
      const j = await r.json();
      state.goals = Array.isArray(j.items) ? j.items : [];
      state.goalsErr = j.error || "";
      state.goalsNombre = j.nombre || "";
      const activo = typeof j.activo === "string" && j.activo.trim() ? j.activo : null;
      const vigente = activo && !gpOcultoPorTexto(activo) ? activo : null;
      state.goal = vigente;
      state.grind = vigente && j.activoTipo === "grind" ? vigente : null;
      renderGoalBar();
    } catch (e) {
      state.goals = [];
      state.goalsErr = String(e && e.message || e);
    }
    renderGoals();
  }
  function fechaCorta(valor) {
    const d = /* @__PURE__ */ new Date(String(valor || "").replace(" ", "T") + "Z");
    if (isNaN(d.getTime())) return String(valor || "");
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function reactivarObjetivo(it) {
    if (!it || !it.texto) return;
    sendText("/" + (it.tipo === "grind" ? "grind" : "goal") + " " + it.texto);
  }
  function gpClave(it) {
    return [it.sid || "", it.cuando || it.actualizado || "", String(it.texto || "").slice(0, 60)].join("|");
  }
  function gpOcultos() {
    try {
      const j = JSON.parse(localStorage.getItem("aegis.goalsOcultos") || "[]");
      return Array.isArray(j) ? j : [];
    } catch (e) {
      return [];
    }
  }
  function gpOcultoEsta(it) {
    return gpOcultos().indexOf(gpClave(it)) !== -1;
  }
  function gpOcultoPorTexto(texto) {
    const sid = state.current && state.current.id || "";
    const buscado = String(texto || "").slice(0, 60);
    if (!buscado) return false;
    return gpOcultos().some((clave) => {
      const partes = String(clave).split("|");
      return partes[2] === buscado && (!sid || !partes[0] || partes[0] === sid);
    });
  }
  function gpOcultar(it) {
    const l = gpOcultos();
    const k = gpClave(it);
    if (l.indexOf(k) === -1) l.push(k);
    try {
      localStorage.setItem("aegis.goalsOcultos", JSON.stringify(l.slice(-400)));
    } catch (e) {
    }
    renderGoals();
  }
  function gpRestaurar() {
    const l = gpOcultos();
    const items = Array.isArray(state.goals) ? state.goals : [];
    const claves = items.map(gpClave);
    const quedan = l.filter((k) => claves.indexOf(k) === -1);
    try {
      localStorage.setItem("aegis.goalsOcultos", JSON.stringify(quedan));
    } catch (e) {
    }
    renderGoals();
  }
  function gpItem(it) {
    const d = document.createElement("div");
    d.className = "gp-item" + (it.activo ? " activo" : "");
    const t = document.createElement("div");
    t.className = "gp-text";
    t.textContent = it.texto || "(sin texto)";
    t.title = it.texto || "";
    const m = document.createElement("div");
    m.className = "gp-meta";
    m.textContent = fechaCorta(it.cuando || it.actualizado) + (it.tipo === "grind" ? " · a fondo" : "");
    const fila = document.createElement("div");
    fila.className = "gp-botones";
    if (it.activo) {
      const q = document.createElement("button");
      q.type = "button";
      q.className = "gp-open";
      q.textContent = "Quitar";
      q.title = "Quitar el objetivo del chat (/goal off)";
      q.addEventListener("click", () => sendText("/goal off"));
      fila.append(q);
    } else {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gp-open";
      b.textContent = "Reactivar";
      b.title = "Volver a poner este objetivo en el chat";
      b.addEventListener("click", () => reactivarObjetivo(it));
      fila.append(b);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "gp-del";
    x.textContent = "×";
    x.title = it.activo ? "Ocultar del panel (el objetivo sigue activo en el chat)" : "Borrar del panel (no toca la conversacion)";
    x.setAttribute("aria-label", "Borrar del panel");
    x.addEventListener("click", () => gpOcultar(it));
    fila.append(x);
    d.append(t, m, fila);
    return d;
  }
  function renderGoals() {
    const body = document.getElementById("gp-body");
    if (!body) return;
    const todos = Array.isArray(state.goals) ? state.goals : [];
    const items = todos.filter((i) => !gpOcultoEsta(i));
    body.innerHTML = "";
    if (!(state.current && state.current.id)) {
      const v = document.createElement("div");
      v.className = "gp-empty";
      v.textContent = "Abri un chat para ver sus objetivos.";
      body.append(v);
      return;
    }
    if (state.goalsErr) {
      const e = document.createElement("div");
      e.className = "gp-empty";
      e.textContent = "No pude leer los objetivos: " + state.goalsErr;
      body.append(e);
    }
    const seccion = (titulo, lista) => {
      const h = document.createElement("div");
      h.className = "gp-sec";
      h.textContent = titulo + " (" + lista.length + ")";
      body.append(h);
      if (!lista.length) {
        const v = document.createElement("div");
        v.className = "gp-empty";
        v.textContent = "Ninguno.";
        body.append(v);
        return;
      }
      for (const it of lista) body.append(gpItem(it));
    };
    const activo = items.filter((i) => i.activo);
    const viejos = items.filter((i) => !i.activo);
    if (activo.length) seccion("En curso", activo);
    if (viejos.length) seccion(activo.length ? "Anteriores" : "Anteriores (ninguno activo)", viejos);
    if (!items.length && !state.goalsErr) {
      const v = document.createElement("div");
      v.className = "gp-empty";
      v.textContent = todos.length ? "Todos los objetivos de este chat estan borrados del panel." : "Este chat todavia no tiene /goal.";
      body.append(v);
    }
    const ocultos = todos.length - items.length;
    if (ocultos > 0) {
      const pie = document.createElement("div");
      pie.className = "gp-pie";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gp-restaurar";
      b.textContent = ocultos === 1 ? "Mostrar el borrado" : "Mostrar los " + ocultos + " borrados";
      b.addEventListener("click", () => gpRestaurar());
      pie.append(b);
      body.append(pie);
    }
  }
  function gpSetVisible(v) {
    const p = document.getElementById("goals");
    if (!p) return;
    p.hidden = !v;
    const btn = document.getElementById("btn-goals");
    if (btn) btn.setAttribute("aria-pressed", v ? "true" : "false");
    if (v) fetchGoals(true);
  }
  function gpEstaAbierto() {
    const p = document.getElementById("goals");
    return !!p && !p.hidden;
  }
  (function wireSalir() {
    const arrancar = () => {
      const btn = document.getElementById("btn-logout");
      if (!btn) return;
      let mostrar = false;
      try {
        mostrar = !!(CFG && (CFG.tunnel || CFG.authed));
      } catch (e) {
      }
      btn.hidden = !mostrar;
      btn.addEventListener("click", () => {
        location.href = "/logout";
      });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arrancar, { once: true });
    else arrancar();
  })();
  (function wireGoals() {
    const arrancar = () => {
      const btn = document.getElementById("btn-goals");
      if (btn) btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        gpSetVisible(document.getElementById("goals").hidden);
      });
      const ref = document.getElementById("gp-refresh");
      if (ref) ref.addEventListener("click", () => fetchGoals(true));
      document.addEventListener("click", (ev) => {
        const p = document.getElementById("goals");
        if (!p || p.hidden) return;
        const camino = typeof ev.composedPath === "function" ? ev.composedPath() : [];
        const dentro = camino.some((n) => n && n.id && (n.id === "goals" || n.id === "btn-goals"));
        if (dentro) return;
        if (ev.target && (p.contains(ev.target) || ev.target.closest && ev.target.closest("#btn-goals"))) return;
        gpSetVisible(false);
      });
      document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") gpSetVisible(false);
      });
      setInterval(() => {
        const p = document.getElementById("goals");
        if (p && !p.hidden) fetchGoals(true);
      }, 6e4);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arrancar, { once: true });
    else arrancar();
  })();
  window.__aegisWeb = { state, setConfig, rpc, readBlock, readHeading, readPump, readToggle, markHiddenTail, goalFromText, gpOcultoPorTexto, noteGoalFrom, fetchGoals, renderGoals, goalsNow: function() {
    return state.goals;
  }, gpSetVisible, goalNow: function() {
    return state.goal;
  }, renderGoalBar, copyId: copySessionId, avisoVacio: avisoTurnoVacio, chunksTurn: () => chunksTurn, renderUsagePublic: renderUsage, metaRight: () => $("#meta-right"), usageDbg: () => state.usageDbg, usageState: () => state.usage, usageLines: () => usageLines(), usageReset: resetUsageForSession, md: (t) => md(t), read: {
    on: () => READ_ON,
    toggle: readToggle,
    pump: readPump,
    flush: readFlush,
    reset: readReset,
    live: { mark: markRun, running: isRunning, done: isDoneRecently, any: anyRunning },
    perChat: { load: readLoad, key: readKeyFor, now: () => READ_ON },
    append: (t) => streamAppend("test-msg", t, false, false),
    draft: { save: saveDraft, load: loadDraft, key: draftKey },
    engine: (m, v) => {
      if (m) READ.engine = m;
      if (v) READ.voiceName = v;
      try {
        localStorage.setItem("aegis.ttsEngine", READ.engine);
        localStorage.setItem("aegis.ttsVoice", READ.voiceName);
      } catch (e) {
      }
      readReset(true);
      return READ.engine + "|" + READ.voiceName;
    },
    block: (t) => readBlock(t),
    clean: (t) => readClean(t),
    state: () => READ
  }, drainRender, flushRender, showWelcome, refreshSessions, slashCommands: () => state.slash.slice(), dropSocket: () => {
    try {
      rpc.ws.close();
    } catch {
    }
  }, probeRun: activeRunId, resync: resyncAdoptedRun, adopt: adoptRun, pendingSteers: loadPending, stopWatch: stopRunWatch, startWatch: startRunWatch, watchTick: watchAdoptedRun, softResync, sweepTools: sweepInterruptedTools, metrics: METRICS, watchDbg: WATCH_DBG, hub: () => ({ soportado: state.hubWatch, sid: state.hubWatchSid, cursor: state.hubCursor, watchers: state.hubWatchers, replay: state.hubReplay }), hubWatchNow: startHubWatch, hubRewatch, hubWatchSession: watchSession, hubUnwatch: () => state.hubWatchSid ? hubUnwatch(state.hubWatchSid) : null, hubInfo: runIdFromInfo, resetMetrics: () => {
    METRICS.renders = 0;
    METRICS.renderMs = 0;
    METRICS.maxRenderMs = 0;
    METRICS.composerRuns = 0;
    METRICS.composerMs = 0;
    METRICS.maxComposerMs = 0;
  }, speedStart, speedFeed: speedChunk, speedFinish, speedReset, speedSummary, turnEndNote };
  if (CFG.host === "mock") window.__aegisWeb.testUi = { update: applyUpdate, usage: onAegisUpdate, rate: stepRate, pop: openUsagePop, busy: setBusy, run: applyActiveRunId, reconcile: hubOrphanTick, addUser, identifyUserBubble, steerDelivered: markSteerDelivered, seedSteer: (mid, el) => {
    state.steers.set(mid, { el, text: "", atts: [] });
    paintQueuedRunBar();
  }, watchRevision: () => liveRunRevision };
  wire();
  rpc.connect();
  report("boot", "app cargada (v6.4+hub+detach+wd+sc)");
})();
