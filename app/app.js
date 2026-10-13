// goose-web · cliente de chat ACP v3 (sin dependencias): sesiones, streaming,
// permisos con botones, adjuntar imágenes, tool cards, chips de modelo.
(() => {
  'use strict';
  const CFG = window.__GOOSE_APP__ || {};
  const $ = (s) => document.querySelector(s);

  // ---------- reporter mínimo ----------
  const report = (kind, msg, extra) => {
    try {
      fetch('/client-log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, msg: String(msg).slice(0, 4000), url: location.href, ua: navigator.userAgent, ...extra }),
      }).catch(() => {});
    } catch {}
  };
  window.addEventListener('error', (e) => report('error', (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')));
  window.addEventListener('unhandledrejection', (e) => report('rejection', String((e.reason && e.reason.message) || e.reason)));

  // ---------- helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTok = (n) => {
    if (n == null) return '–';
    if (n < 1000) return String(n);
    if (n < 1000000) return (Math.round(n / 100) / 10).toString().replace(/\.0$/, '') + 'k';
    return (Math.round(n / 104857.6) / 10).toString().replace(/\.0$/, '') + 'M';
  };
  const fmtCost = (c) => {
    if (c == null) return '';
    if (c === 0) return '$0';
    const s = c < 0.01 ? c.toFixed(5) : c.toFixed(4);
    return '$' + s.replace(/0+$/, '').replace(/\.$/, '');
  };
  const fmtSize = (n) => {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 102.4) / 10 + ' KB';
    return Math.round(n / 104857.6) / 10 + ' MB';
  };
  const greeting = () => {
    const h = new Date().getHours();
    return h >= 6 && h < 13 ? 'Buenos días' : h >= 13 && h < 20 ? 'Buenas tardes' : 'Buenas noches';
  };
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const dayLabel = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return 'Más antiguas';
    const now = new Date();
    if (sameDay(d, now)) return 'Hoy';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return 'Ayer';
    if (now - d < 7 * 864e5) return 'Esta semana';
    if (now - d < 31 * 864e5) return 'Este mes';
    return 'Más antiguas';
  };
  const fmtTime = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    if (sameDay(d, now)) return d.toTimeString().slice(0, 5);
    return d.getDate() + '/' + (d.getMonth() + 1);
  };

  // ---------- markdown ----------
  const inline = (t) => {
    let s = esc(t);
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  };
  // ---- tablas (pipes) ----
  // Fila de encabezado + separador (|---|---|) + filas. Sin esto el operador veía los "|"
  // crudos en el chat (reporte con foto del 2026-10-12).
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l);
  const splitRow = (l) => {
    let s = String(l).trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  };
  const alignsOf = (sep) => splitRow(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  const tableHtml = (head, aligns, rows) => {
    const cell = (tag, txt, i) => { const a = aligns[i]; return `<${tag}${a ? ` style="text-align:${a}"` : ''}>${inline(txt)}</${tag}>`; };
    return '<div class="tbl-wrap"><table><thead><tr>' + head.map((c, i) => cell('th', c, i)).join('') + '</tr></thead>'
      + (rows.length ? '<tbody>' + rows.map((r) => '<tr>' + head.map((_, i) => cell('td', r[i] == null ? '' : r[i], i)).join('') + '</tr>').join('') + '</tbody>' : '')
      + '</table></div>';
  };
  const mdBlocks = (t) => {
    const lines = t.split(/\r?\n/);
    let out = '';
    let para = [];
    let list = [];
    let listType = null;
    const flushPara = () => { if (para.length) { out += `<p>${para.join('<br>')}</p>`; para = []; } };
    const flushList = () => { if (listType) { out += `<${listType}>${list.map((x) => `<li>${x}</li>`).join('')}</${listType}>`; listType = null; list = []; } };
    for (let _i = 0; _i < lines.length; _i++) {
      const line = lines[_i];
      if (line.includes('|') && _i + 1 < lines.length && isTableSep(lines[_i + 1])) {
        flushPara(); flushList();
        const head = splitRow(line);
        const aligns = alignsOf(lines[_i + 1]);
        const rows = [];
        let j = _i + 2;
        while (j < lines.length && lines[j].includes('|') && !/^\s*$/.test(lines[j])) { rows.push(splitRow(lines[j])); j++; }
        out += tableHtml(head, aligns, rows);
        _i = j - 1;
        continue;
      }
      const mH = /^(#{1,5})\s+(.*)$/.exec(line);
      const mUl = /^\s*[-*•]\s+(.*)$/.exec(line);
      const mOl = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      const mQ = /^>\s?(.*)$/.exec(line);
      const mHr = /^\s*([-*_])\1{2,}\s*$/.test(line);
      if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
      if (mHr) { flushPara(); flushList(); out += '<hr>'; continue; }
      if (mH) { flushPara(); flushList(); const lvl = Math.min(mH[1].length + 2, 5); out += `<h${lvl}>${inline(mH[2])}</h${lvl}>`; continue; }
      if (mUl) { flushPara(); if (listType !== 'ul') { flushList(); listType = 'ul'; } list.push(inline(mUl[1])); continue; }
      if (mOl) { flushPara(); if (listType !== 'ol') { flushList(); listType = 'ol'; } list.push(inline(mOl[1])); continue; }
      if (mQ) { flushPara(); flushList(); out += `<blockquote>${inline(mQ[1])}</blockquote>`; continue; }
      flushList();
      para.push(inline(line));
    }
    flushPara(); flushList();
    return out;
  };
  const md = (text) => {
    const parts = String(text ?? '').split('```');
    let html = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        const body = parts[i].replace(/^[a-zA-Z0-9+#_.-]* ?\r?\n/, '').replace(/\r?\n$/, '');
        html += `<div class="code-wrap"><button class="copy-code" type="button">Copiar</button><pre><code>${esc(body)}</code></pre></div>`;
      } else {
        html += mdBlocks(parts[i]);
      }
    }
    return html;
  };

  // ---------- copy (funciona en http LAN: fallback execCommand) ----------
  const copyText = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  };

  // ---------- estado ----------
  const state = {
    sessions: [],
    archived: [],
    current: null,
    msgs: new Map(),
    tools: new Map(),
    seq: 0,
    busy: false,
    filter: '',
    booted: false,
    attachments: [],
    permCard: null, // {id, el}
    hold: null, // 'rename' | 'confirm' — pausa re-renders mientras hay UI inline abierta
    runId: null, // id del run activo del server (para steering)
    adopted: false,
    resyncing: false,
    suppressSettle: false, // true si el turno en curso lo arrancó otra conexión (o sobrevivió a un reload)
    steers: new Map(), // messageId -> burbuja local del steer encolado
    queue: [], // mensajes escritos mientras el agente trabaja y no hay run al que apuntar
    slash: [], // comandos disponibles (notification available_commands_update / RPC)
    slashLoaded: false,
    slashLoading: false,
    slashItems: [],
    slashIdx: 0,
    replaying: false, // true mientras se reproduce un historial (evita autoscroll por chunk)
    pages: 1, // páginas de session/list ya traídas
    cursor: null,
    showArchived: false,
    welcomeMode: 'new',
    // ---------- v6.4: watch por sesión (hub con fan-out) ----------
    hubWatch: undefined, // true = el server implementa _goose/unstable/session/watch; false = v2/v3
    hubCursor: null, // último cursor del hub para la sesión en pantalla (re-watch al reconectar)
    hubWatchSid: null, // sesión a la que está enganchada esta conexión
    hubWatchers: null, // watcherCount que reportó el server (hint de UI)
    hubReplay: false, // true mientras se aplica el replay de un watch
  };

  // ---------- RPC / WS ----------
  const rpc = {
    ws: null, nextId: 1, pending: new Map(), backoff: 1000, ready: false, retrying: null,
    connect() {
      clearTimeout(this.retrying);
      setStatus('warn', 'Conectando…');
      let ws;
      try { ws = new WebSocket(CFG.acpUrl); } catch (e) { report('error', 'WS ctor: ' + e.message); setStatus('err', 'Sin conexión'); return; }
      this.ws = ws;
      ws.onopen = async () => {
        try {
          await this.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { _meta: { goose: { customNotifications: true, toolCallLabelEnrichment: true } } },
            clientInfo: { name: 'goose-web', version: '1.3' },
            _meta: { 'goose/useLoginShellPath': true },
          });
          const wasReady = this.ready;
          this.ready = true; this.backoff = 1000;
          setStatus('ok', 'Conectado');
          if (!state.booted) { state.booted = true; onBoot(); }
          else if (!wasReady) {
            refreshSessions();
            finishStream();
            // El run que estaba en curso murió con la conexión vieja: la UI no puede
            // quedarse mostrando "detener" para un turno que ya no existe.
            // (v6.4) Con watch por sesión el run NO muere con la conexión: si estábamos
            // enganchados al hub decide el re-watch (su respuesta trae `activeRunId`) y no
            // corresponde declarar el turno interrumpido.
            if (state.hubWatch === true) await hubRewatch();
            else if (state.busy) setBusy(false, 'Se cortó la conexión: el turno se interrumpió');
            flushQueue();
          }
          // (v6.4) Con hub no se sondea al abrir: el estado del run viene en la respuesta de
          // watch y el fin de turno por evento. Sin soporte de watch, camino viejo intacto.
          if (state.hubWatch !== true) checkAdoptedRun();
        } catch (e) {
          report('error', 'initialize: ' + e.message);
          try { ws.close(); } catch {}
        }
      };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { report('error', 'mensaje ilegible'); return; }
        if (m.id !== undefined && m.method === undefined) {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            if (m.error) {
              // Conservamos data/code: el data de un steer trae el run activo real
              // ("actualRunId") y el de un prompt nombra el run que ya esta en curso.
              const err = new Error((m.error && m.error.message) || 'error RPC');
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
        state.suppressSettle = true; // caida de red != turno terminado
        // (v6.4) El hub desengancha al watcher cuando muere la conexión: al reconectar hay
        // que volver a engancharse (con el último cursor) para no quedar mudo.
        state.hubWatchSid = null;
        // Nadie va a contestar por esta conexión: rechazamos lo pendiente. Si no,
        // un `session/prompt` colgado deja state.busy=true para siempre y la UI
        // queda muda (no envía ni responde a Detener) hasta recargar la página.
        const pend = [...this.pending.values()];
        this.pending.clear();
        for (const p of pend) { try { p.rej(new Error('conexión cerrada')); } catch {} }
        if (state.booted) setStatus('warn', 'Reconectando…');
        const delay = this.backoff; this.backoff = Math.min(this.backoff * 2, 15000);
        this.retrying = setTimeout(() => this.connect(), delay);
      };
      ws.onerror = () => {};
    },
    request(method, params) {
      return new Promise((res, rej) => {
        const id = this.nextId++;
        this.pending.set(id, { res, rej });
        try { this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
        catch (e) { this.pending.delete(id); rej(e); }
      });
    },
    notify(method, params) {
      try { this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params })); } catch {}
    },
    respond(id, result) {
      try { this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result })); } catch {}
    },
  };

  let titleLock = null; // {id, title, until} — el server auto-titula; no pisar un rename del usuario

  function handleServerMessage(m) {
    if (m.method === 'session/update') return onUpdate(m.params || {});
    if (m.method === '_goose/unstable/session/update') return onGooseUpdate(m.params || {});
    if (m.method === 'session/request_permission') return showPermCard(m);
    // (v6.4) El hub avisa que truncó su ring: hay que recargar la conversación completa.
    if (m.method === '_goose/unstable/session/replay_gap') return onReplayGap(m.params || {});
    if (m.id !== undefined) {
      try { rpc.ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no soportado: ' + m.method } })); } catch {}
    }
  }

  // ---------- notificaciones de sesión ----------
  // (v6.6) Al abrir un chat el replay entero llega ANTES de que responda session/load.
  // En vez de pintarlo a medida que llega (del principio hacia el final, que es lo que
  // dejaba al usuario mirando los mensajes viejos), se guarda aca y se pinta en dos
  // fases en paintReplayTwoPhase(): primero el final, despues el resto arriba.
  function onUpdate(params) {
    if (state.replayBuf) { state.replayBuf.push(params); return; }
    applyUpdate(params);
  }

  function applyUpdate(params) {
    const cur = state.current;
    if (!cur || params.sessionId !== cur.id) return;
    const u = params.update || {};
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        // Un steer confirmado vuelve como user_message_chunk con el mismo messageId:
        // en ese caso la burbuja ya está en pantalla y solo se destilda "en cola".
        const mid = u.messageId;
        if (mid && state.steers.has(mid)) { markSteerDelivered(mid); break; }
        // (v6.4) Con el hub, el eco del propio prompt también llega como notificación (en
        // v3 iba sólo a la conexión dueña, que ya lo tenía pintado) y el replay puede
        // repetir lo que ya trajo el session/load: se adopta o se descarta, sin duplicar.
        if (mid && userBubbleOnScreen(mid)) break;
        if (mid && u.content && u.content.type === 'text' && adoptLocalEcho(mid, u.content.text)) break;
        if (u.content && u.content.type === 'text') addUser(u.content.text, true, null, { mid });
        else if (u.content && u.content.type === 'image') addUser('', true, [u.content], { mid });
        break;
      }
      case 'agent_message_chunk':
        if (u.content && u.content.type === 'text') streamAppend(u.messageId || 'a', u.content.text, false);
        break;
      case 'agent_thought_chunk':
        if (u.content && u.content.type === 'text') streamAppend(thoughtKeyFor(u), u.content.text, true);
        break;
      case 'tool_call':
      case 'tool_call_update':
        toolUpsert(u);
        break;
      case 'usage_update':
        setUsage(u);
        break;
      case 'message_usage':
        setMsgUsage(u.usage);
        break;
      case 'available_commands_update':
        if (Array.isArray(u.availableCommands)) {
          state.slash = u.availableCommands;
          state.slashLoaded = true;
          refreshSlashMenu();
        }
        break;
      case 'session_info_update': {
        const g = (u._meta && u._meta.goose) || {};
        // (v6.4) El estado del run pasa por applyActiveRunId: con el hub es también el
        // aviso de fin de turno del DUEÑO del prompt, no sólo del turno adoptado.
        if (g.activeRunId !== undefined) applyActiveRunId(g.activeRunId || null);
        if (g.queuedSteer && state.steers.has(g.queuedSteer.messageId)) {
          state.steers.get(g.queuedSteer.messageId).serverQueued = true;
          setQueuedNote(state.steers.get(g.queuedSteer.messageId), 'indicación encolada en el server…');
        }
        const locked = titleLock && titleLock.id === cur.id && Date.now() < titleLock.until;
        if (u.title && !locked) { cur.title = u.title; updateTitle(); }
        if (Array.isArray(u.configOptions)) { cur.configOptions = u.configOptions; renderChips(); }
        if (u.modes) cur.modes = u.modes;
        break;
      }
      default:
        break;
    }
  }

  function onGooseUpdate(params) {
    const cur = state.current;
    if (!cur) return;
    const u = params.update || {};
    // (v6.4) El arranque y el FIN de turno llegan por acá (`params.goose.activeRunId`): con
    // el hub es el único aviso cuando el response del prompt se pierde (reload, socket
    // caído) o cuando el turno lo arrancó otra conexión.
    const g = params.goose || (u._meta && u._meta.goose) || (params._meta && params._meta.goose);
    if (g && g.activeRunId !== undefined && (!params.sessionId || params.sessionId === cur.id)) applyActiveRunId(g.activeRunId || null);
    if (params.sessionId !== cur.id) return; // el resto de las notificaciones sí son de esta sesión
    if (u.sessionUpdate === 'usage_update') setUsage(u);
    if (u.sessionUpdate === 'message_usage') setMsgUsage(u.usage);
    if (u.sessionUpdate === 'status_message' && u.status && u.status.type === 'progress' && u.status.message) {
      setPill(u.status.message);
    }
  }

  // ---------- render: sesiones ----------
  const rowHtml = (s, archived) => {
    const meta = s._meta || {};
    const active = state.current && state.current.id === s.sessionId ? ' active' : '';
    const n = meta.messageCount;
    const sub = `${n != null ? n + ' · ' : ''}${fmtTime(s.updatedAt || meta.createdAt)}`;
    return (
      `<div class="sb-row" data-id="${esc(s.sessionId)}"${archived ? ' data-arch="1"' : ''}>` +
      `<button class="sb-item${active}${archived ? ' arch' : ''}"><div class="sb-title">${esc(s.title || 'Sesión')}${archived ? '<span class="sb-tag">archivada</span>' : ''}</div><div class="sb-sub">${sub}</div></button>` +
      `<button class="sb-rename" title="Renombrar" aria-label="Renombrar">✎</button>` +
      `<button class="sb-more" title="Más acciones" aria-label="Más acciones">⋮</button>` +
      `<button class="sb-del" title="Borrar sesión" aria-label="Borrar sesión">✕</button>` +
      `</div>`
    );
  };

  function renderList() {
    if (state.hold) return; // no pisar un editor/confirm abierto
    const list = $('#session-list');
    const q = state.filter.trim().toLowerCase();
    const match = (s) => !q || String(s.title || '').toLowerCase().includes(q);
    // Orden por recencia en el cliente: el server a veces intercala por la clave de
    // paginación y quedaban grupos "Hoy/Ayer" desordenados.
    const ts = (s) => Date.parse(s.updatedAt || (s._meta && s._meta.createdAt) || '') || 0;
    const byRecency = (a, b) => ts(b) - ts(a);
    const items = state.sessions.filter(match).sort(byRecency);
    const arch = state.archived.filter(match).sort(byRecency);
    let html = '';
    if (!items.length && !arch.length) {
      list.innerHTML = `<div class="sb-empty">${state.sessions.length || state.archived.length ? 'Sin resultados' : 'Sin sesiones todavía'}</div>`;
      return;
    }
    let lastGroup = null;
    for (const s of items) {
      const group = dayLabel(s.updatedAt || (s._meta && s._meta.createdAt));
      if (group !== lastGroup) { html += `<div class="sb-group">${group}</div>`; lastGroup = group; }
      html += rowHtml(s, false);
    }
    if (state.cursor) {
      const more = state.pages > 1 ? `Cargar más (${state.pages} páginas)` : 'Cargar más sesiones';
      html += `<button class="sb-more-btn" type="button">${more}</button>`;
    }
    if (arch.length || state.archived.length) {
      if (state.showArchived) {
        html += `<div class="sb-group">Archivadas</div>`;
        html += arch.length ? arch.map((s) => rowHtml(s, true)).join('') : `<div class="sb-empty">Ninguna coincide con la búsqueda.</div>`;
        html += `<button class="sb-arch-toggle open" type="button"><span class="caret">▶</span> Ocultar archivadas</button>`;
      } else {
        const total = state.archived.length;
        html += `<button class="sb-arch-toggle" type="button"><span class="caret">▶</span> Ver archivadas (${total})</button>`;
      }
    }
    list.innerHTML = html;
  }

  // ---------- acciones por sesión (menú de fila, archivar, exportar) ----------
  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, kind === 'err' ? 4200 : 2600);
  }

  const closeRowMenus = () => document.querySelectorAll('body > .menu.row-menu').forEach((m) => m.remove());

  function openRowMenu(btn, id, archived) {
    closeMenus(); closeRowMenus();
    const menu = document.createElement('div');
    menu.className = 'menu row-menu';
    const entry = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'menu-row'; b.type = 'button';
      b.innerHTML = `<span>${label}</span>`;
      b.addEventListener('click', (e) => { e.stopPropagation(); menu.remove(); fn(); });
      menu.appendChild(b);
    };
    entry('Renombrar', () => startRename(id));
    entry('Exportar como Markdown', () => exportSession(id, 'markdown'));
    entry('Exportar como JSON', () => exportSession(id, 'json'));
    if (archived) entry('Desarchivar', () => unarchiveSession(id));
    else entry('Archivar', () => archiveSession(id));
    document.body.appendChild(menu);
    openMenu(btn, menu);
  }

  const findSession = (id) => state.sessions.find((s) => s.sessionId === id) || state.archived.find((s) => s.sessionId === id);

  async function archiveSession(id) {
    try {
      await rpc.request('_goose/unstable/session/archive', { sessionId: id });
    } catch (e) { toast('No se pudo archivar: ' + e.message, 'err'); return; }
    const s = state.sessions.find((x) => x.sessionId === id);
    state.sessions = state.sessions.filter((x) => x.sessionId !== id);
    if (s) {
      s._meta = { ...(s._meta || {}), archivedAt: new Date().toISOString() };
      state.archived = [s, ...state.archived.filter((x) => x.sessionId !== id)];
    }
    if (!state.archived.length) refreshSessions();
    else { state.showArchived = true; renderList(); }
    toast('Sesión archivada — está en «Archivadas».');
  }

  async function unarchiveSession(id) {
    try {
      await rpc.request('_goose/unstable/session/unarchive', { sessionId: id });
    } catch (e) { toast('No se pudo desarchivar: ' + e.message, 'err'); return; }
    const s = state.archived.find((x) => x.sessionId === id);
    state.archived = state.archived.filter((x) => x.sessionId !== id);
    if (s) {
      delete (s._meta || {}).archivedAt;
      state.sessions = [s, ...state.sessions.filter((x) => x.sessionId !== id)];
    }
    renderList();
    toast('Sesión desarchivada.');
  }

  function downloadFile(name, mime, text) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 6000);
      return true;
    } catch { return false; }
  }

  async function exportSession(id, format) {
    const entry = findSession(id);
    const base = ((entry && entry.title) || id).replace(/[^\w\-. áéíóúÁÉÍÓÚñÑ]+/g, '_').trim().slice(0, 60).replace(/^[.\s]+/, '') || id;
    const ext = format === 'markdown' ? 'md' : 'json';
    let data = '';
    try {
      const res = await rpc.request('_goose/unstable/session/export', { sessionId: id, format });
      data = (res && res.data) || '';
    } catch (e) { toast('No se pudo exportar: ' + e.message, 'err'); return; }
    if (!data) { toast('La exportación vino vacía.', 'err'); return; }
    const ok = downloadFile(`${base}.${ext}`, format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8', data);
    if (ok) toast(`Exportada «${base}.${ext}» (${fmtSize(data.length)}).`);
    else {
      const copied = await copyText(data);
      toast(copied ? 'Descarga bloqueada: la exportación quedó en el portapapeles.' : 'No se pudo exportar en este navegador.', copied ? '' : 'err');
    }
  }

  function markActive(id) {
    document.querySelectorAll('.sb-item').forEach((el) => el.classList.toggle('active', el.parentElement.dataset.id === id));
  }

  async function refreshSessions() {
    const pages = Math.max(1, state.pages);
    const all = [];
    let cursor = null;
    try {
      for (let i = 0; i < pages; i++) {
        const res = await rpc.request('session/list', {
          cursor: cursor || undefined,
          meta: { goose: { includeLastMessageSnippet: false } },
        });
        all.push(...((res && res.sessions) || []));
        cursor = (res && res.nextCursor) || null;
        if (!cursor) break;
      }
      state.sessions = all.filter((s) => !(s._meta && s._meta.archivedAt));
      state.archived = all.filter((s) => s._meta && s._meta.archivedAt);
      state.cursor = cursor;
      renderList();
    } catch (e) {
      report('error', 'session/list: ' + e.message);
    }
  }

  async function loadMoreSessions() {
    const btn = document.querySelector('.sb-more-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Cargando…'; }
    state.pages += 1;
    await refreshSessions();
  }

  function askDelete(id) {
    const row = document.querySelector(`.sb-row[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const body = row.querySelector('.sb-item');
    if (row.querySelector('.sb-confirm')) return;
    state.hold = 'confirm';
    body.style.display = 'none';
    const c = document.createElement('div');
    c.className = 'sb-confirm';
    c.innerHTML = '<span>¿Borrar sesión?</span><button class="ym">Sí</button><button class="nn">No</button>';
    row.appendChild(c);
    c.querySelector('.nn').addEventListener('click', (e) => { e.stopPropagation(); state.hold = null; renderList(); });
    c.querySelector('.ym').addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await rpc.request('session/delete', { sessionId: id }); }
      catch (err) { systemNote('No se pudo borrar: ' + err.message); }
      state.sessions = state.sessions.filter((s) => s.sessionId !== id);
      if (state.current && state.current.id === id) {
        state.current = null;
        state.msgs.clear(); state.tools.clear();
        updateTitle(); renderChips();
      }
      if (!state.current) { clearMessages(); showWelcome('new'); }
      state.hold = null;
      renderList();
    });
  }

  function startRename(id) {
    const row = document.querySelector(`.sb-row[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const titleEl = row.querySelector('.sb-title');
    const entry = state.sessions.find((s) => s.sessionId === id);
    const input = document.createElement('input');
    input.className = 'sb-edit';
    input.value = (entry && entry.title) || titleEl.textContent || '';
    titleEl.replaceWith(input);
    input.focus(); input.select();
    state.hold = 'rename';
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const title = input.value.trim();
      if (save && title) {
        let ok = false;
        try { await rpc.request('_goose/unstable/session/rename', { sessionId: id, title }); ok = true; }
        catch (e) { systemNote('No se pudo renombrar: ' + e.message); }
        if (ok) {
          const fresh = state.sessions.find((s) => s.sessionId === id);
          if (fresh) fresh.title = title;
          titleLock = { id, title, until: Date.now() + 15000 }; // el server puede anunciar su auto-título después
          if (state.current && state.current.id === id) { state.current.title = title; updateTitle(); }
        }
      }
      state.hold = null;
      renderList();
      if (save && title) refreshSessions();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // ---------- render: mensajes ----------
  function msgWrap() {
    if (state.offscreen) return state.offscreen; // fase B: el historial viejo se pinta aparte
    let w = $('#msg-inner');
    if (!w) {
      hideWelcome();
      w = document.createElement('div'); w.id = 'msg-inner'; w.className = 'msg-inner';
      $('#messages').appendChild(w);
    }
    return w;
  }
  function showWelcome(mode, title) {
    const w = $('#welcome');
    if (!w) return;
    state.welcomeMode = mode || 'new';
    const h1 = $('#welcome-h1');
    const sub = w.querySelector('.welcome-sub');
    if (state.welcomeMode === 'empty') {
      if (h1) h1.textContent = 'Sesión sin mensajes';
      if (sub) sub.textContent = (title ? `«${title}» ` : 'Esta sesión ') + 'todavía no tiene mensajes. Escribí abajo para arrancar la conversación.';
    } else {
      if (h1) h1.textContent = greeting();
      if (sub) sub.textContent = 'Goose está listo. Puede leer y editar archivos de esta máquina, correr comandos y buscar en la web.';
    }
    w.hidden = false;
  }
  const hideWelcome = () => { $('#welcome')?.setAttribute('hidden', ''); };
  const scrollBottom = (force) => {
    if (state.replaying) return; // durante el replay medimos una sola vez, al final
    const m = $('#messages');
    if (force || state.pinUntil > performance.now() || m.scrollHeight - m.scrollTop - m.clientHeight < 140) m.scrollTop = m.scrollHeight;
  };

  function addUser(text, replay, atts, opts) {
    // Durante un refresco suave no se toca el DOM: se bufferea y se aplica al final
    // (sólo las burbujas nuevas; las que ya están pintadas se saltan por messageId).
    if (SOFT.on && replay && !(opts && opts.local)) {
      SOFT.users.push({ text, atts, mid: (opts && opts.mid) || '' });
      softPush('user', SOFT.users.length - 1);
      return null;
    }
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'msg-user' + (opts && opts.queued ? ' queued' : ''); if (!replay) el.classList.add('in');
    if (opts && opts.mid) el.dataset.mid = opts.mid;
    let html = text ? md(text) : '';
    for (const a of atts || []) {
      if (a && a.kind === 'text') html += `<div class="att-note">📄 ${esc(a.name)}</div>`;
      else if (a && a.data && a.mimeType) html += `<img src="data:${esc(a.mimeType)};base64,${a.data}" alt="${esc(a.name || 'adjunto')}">`;
    }
    el.innerHTML = html;
    msgWrap().appendChild(el);
    scrollBottom(replay);
    return el;
  }

  const setQueuedNote = (el, msg) => {
    if (el && el.el) el = el.el; // acepta {el, text, atts}
    if (!el) return;
    let n = el.querySelector('.steer-note');
    if (!n) { n = document.createElement('div'); n.className = 'steer-note'; el.appendChild(n); }
    n.textContent = msg;
  };

  // Un solo rAF para todos los registros sucios: escribe el DOM en lote y mide
  // después (evita un layout forzado por chunk, que es lo que mataba el replay).
  // Métricas de costo real (para verificar en el teléfono, no adivinar):
  // cuánto cuesta re-renderizar el mensaje que crece y cuánto el trabajo por tecla.
  const METRICS = { renders: 0, renderMs: 0, maxRenderMs: 0, lastRenderMs: 0, composerRuns: 0, composerMs: 0, maxComposerMs: 0 };

  // ---------- refresco suave del turno adoptado ----------
  // El server re-emite TODA la conversación en cada session/load. Reconstruir el DOM
  // completo (clearMessages + replay) costaba ~2,3 s de main thread bloqueado en una
  // sesión de ~780 mensajes (medido en móvil con CPU 4x, tramos de hasta 206 ms): si el
  // usuario estaba tecleando, las teclas llegaban tarde. Acá lo que llega del replay se
  // guarda en buffers y al final sólo se pinta lo nuevo (lo ya pintado no se toca).
  const SOFT = { on: false, text: new Map(), kind: new Map(), users: [], tools: new Map(), order: [] };
  let lastTypedAt = 0;
  let lastSoftAt = 0;
  const SOFT_MIN_MS = 12000;   // no refrescar más seguido que esto
  const SOFT_REFRESH_MS = 15000; // respaldo periódico (el messageCount puede venir congelado)
  let softBackoffMs = SOFT_REFRESH_MS; // se espacia solo si el replay del server pesa mucho
  const SOFT_QUIET_MS = 2500;  // no refrescar el DOM si el usuario tecleó hace menos
  const softReset = () => { SOFT.text.clear(); SOFT.kind.clear(); SOFT.tools.clear(); SOFT.order = []; SOFT.users = []; };
  const softPush = (tipo, k) => {
    for (let i = SOFT.order.length - 1; i >= 0 && i > SOFT.order.length - 60; i--) {
      if (SOFT.order[i][0] === tipo && SOFT.order[i][1] === k) return;
    }
    SOFT.order.push([tipo, k]);
  };
  const dirty = new Set();
  let rafId = 0;
  let renderTimer = 0;
  const STREAM_RENDER_MS = 90;
  const STREAM_RENDER_MS_TYPING = 260; // tecleando: menos re-render, mas respuesta del teclado // el mensaje que está creciendo se re-renderiza ~11 veces/s
  // El replay de una sesión enorme marca miles de registros dirty a la vez; pintarlos todos en un
  // frame cuesta ~2,3 s de main thread (medido) y en el teléfono las teclas llegan tarde. Se pinta
  // por tramos: se sigue hasta agotar el presupuesto de tiempo del frame y el resto va al próximo.
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
      // No re-parseamos markdown + innerHTML del texto entero en cada frame para el
      // mensaje que se está streameando: en un teléfono eso satura el main thread
      // (60 renders/s del texto completo) y el teclado empieza a perder teclas.
      const age = now - (rec.lastAppend || 0);
      const streamMs = (performance.now() - lastTypedAt < 400) ? STREAM_RENDER_MS_TYPING : STREAM_RENDER_MS;
      if (rec.live && age < streamMs) { wait = Math.max(wait, streamMs - age); continue; }
      if (done >= RENDER_MIN_PER_FRAME && performance.now() - frameT0 >= RENDER_BUDGET_MS) break;
      done++;
      dirty.delete(rec);
      rec.dirty = false;
      const _t0 = performance.now();
      rec.body.innerHTML = md(rec.text);
      const _dt = performance.now() - _t0;
      METRICS.renders++; METRICS.renderMs += _dt; METRICS.lastRenderMs = _dt;
      if (_dt > METRICS.maxRenderMs) METRICS.maxRenderMs = _dt;
      if (rec.body.classList.contains('thought')) measure.push(rec);
    }
    for (const rec of measure) rec.body.classList.toggle('short', rec.body.scrollHeight <= rec.body.clientHeight + 2);
    scrollBottom();
    // Lo que quedó sin pintar sigue en `dirty`: va en el próximo frame (sin bloquear el teclado).
    if (dirty.size && !rafId && !renderTimer) {
      rafId = requestAnimationFrame(flushRender);
    }
    // Borde final garantizado: lo que quedó frenado se pinta cuando vence la ventana.
    if (dirty.size && !renderTimer) {
      renderTimer = setTimeout(() => {
        renderTimer = 0;
        if (!rafId) rafId = requestAnimationFrame(flushRender);
      }, Math.max(24, Math.round(wait)));
    }
  }
  // Espera a que el render por tramos drene (o se acabe el tiempo): el replay se pinta por partes,
  // así que el scroll final y el cierre del replay tienen que esperar al último tramo.
  const drainRender = async (maxMs = 5000) => {
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
      if (curStream.__rec) curStream.__rec.live = false; // vuelve a render "completo/instantáneo"
      curStream.classList.remove('streaming');
      curStream = null;
    }
  }
  function closeAllRecs() {
    for (const r of new Set(state.msgs.values())) { r.closed = true; r.live = false; }
  }
  function finishStream() {
    clearStreaming();
    setPill(null);
  }

  // (v6.5) Un solo contenedor de razonamiento mientras no se intercale nada mas: el
  // server puede abrir un mensaje nuevo (id nuevo) a mitad del mismo razonamiento y el
  // bloque quedaba partido en dos cajas. Se reusa el nodo de razonamiento solo si sigue
  // siendo el ultimo hijo de la lista; asi el texto nunca queda fuera de orden respecto
  // de una tool o de la respuesta.
  function thoughtKeyFor(u) {
    const wrap = msgWrap();
    const prev = state.thoughtRec;
    if (prev && prev.el.parentElement === wrap && prev.el === wrap.lastElementChild) {
      return state.thoughtKey;
    }
    state.thoughtKey = 'think:' + (u.messageId || 'a') + ':' + Date.now().toString(36);
    state.thoughtRec = null;
    return state.thoughtKey;
  }

  function streamAppend(key, text, thought) {
    // (v6.4) Replay del hub: el mismo mensaje parcial puede haberlo traído ya el
    // session/load, así que el texto del replay se acumula aparte y se reconcilia por
    // prefijo común (hubApplyReplayText) en vez de pegarse dos veces.
    if (state.hubReplay) {
      HUB.text.set(key, (HUB.text.get(key) || '') + text);
      HUB.kind.set(key, !!thought);
      return;
    }
    // Refresco suave: acumular sin tocar el DOM (se aplica al final, sólo lo nuevo).
    if (SOFT.on) {
      SOFT.text.set(key, (SOFT.text.get(key) || '') + text);
      SOFT.kind.set(key, !!thought);
      softPush('text', key);
      return;
    }
    hideWelcome();
    // Si llegan chunks y no teníamos un turno en curso, el run lo arrancó otra
    // conexión (o sobrevivió a un reload): lo adoptamos para poder mostrarlo y cortarlo.
    noteRunActivity();
    let rec = state.msgs.get(key);
    if (rec && rec.closed) {
      // (v6.6) Un cierre a mitad de turno (closeAllRecs) partia el razonamiento en dos
      // cajas. Si la caja sigue siendo lo ultimo pintado, se reusa en vez de abrir otra;
      // si algo se interpuso (tool, respuesta, burbuja), se abre una nueva.
      const w = msgWrap();
      if (thought && rec.el.parentElement === w && rec.el === w.lastElementChild) rec.closed = false;
      else rec = null;
    }
    if (!rec) {
      if (!thought) clearStreaming();
      const el = document.createElement('div');
      el.className = 'msg-a';
      const body = document.createElement('div');
      body.className = thought ? 'thought' : 'content';
      el.appendChild(body);
      const cp = document.createElement('button');
      cp.className = 'msg-copy'; cp.type = 'button'; cp.textContent = 'Copiar';
      el.appendChild(cp);
      msgWrap().appendChild(el);
      rec = { el, body, text: '', dirty: false, closed: false, live: false, lastAppend: 0 };
      el.__rec = rec;
      state.msgs.set(key, rec);
      if (thought) state.thoughtRec = rec;
      if (!thought) curStream = el;
    }
    rec.text += text;
    rec.lastAppend = performance.now();
    rec.live = !state.replaying; // durante un replay se pinta una sola vez, al final
    queueRender(rec);
    if (!thought && rec.el !== curStream) { clearStreaming(); curStream = rec.el; }
    // Durante un replay del historial no hay streaming real: si se marcara acá,
    // el último mensaje reproducido queda con el cursor pegado para siempre.
    if (!state.replaying) { rec.el.classList.add('in'); if (!thought) rec.el.classList.add('streaming'); }
    scrollBottom();
  }

  // Icono por tipo de herramienta: se elige por el nombre que manda el server.
  const TOOL_ICON = {
    shell: '<path d="M4.6 5.4 7.2 8l-2.6 2.6M9.4 11h3.2"/>',
    read: '<path d="M4 2.8h4.6L12 6.2v7H4z"/><path d="M8.4 2.8v3.4H12"/><path d="M6 9.6h4"/>',
    write: '<path d="M3 13.2l.9-2.9 6-6 2 2-6 6z"/><path d="M9.4 4.9l2 2"/>',
    image: '<rect x="2.6" y="3.4" width="10.8" height="9.2" rx="1.6"/><path d="M2.6 10.2 5.6 7.4l2.2 2.2 1.8-1.8 3 2.8"/>',
    search: '<circle cx="7.4" cy="7.4" r="3.8"/><path d="M10.2 10.2 13.4 13.4"/>',
    glob: '<circle cx="8" cy="8" r="5.2"/><path d="M2.8 8h10.4M8 2.8c1.6 1.6 1.6 8.8 0 10.4M8 2.8c-1.6 1.6-1.6 8.8 0 10.4"/>',
    code: '<path d="M5.6 5.4 3 8l2.6 2.6M10.4 5.4 13 8l-2.6 2.6"/>',
    cross: '<path d="M4.8 4.8l6.4 6.4M11.2 4.8l-6.4 6.4"/>',
    dot: '<circle cx="8" cy="8" r="2.6"/>',
  };
  function toolIconSvg(kind, status) {
    if (status === 'failed') kind = 'cross';
    const name = String(kind || '').toLowerCase().replace(/[_-]/g, ' ').trim();
    if (!TOOL_ICON[kind]) {
      kind = /shell|terminal|bash|powershell|exec|cmd/.test(name) ? 'shell'
        : /image|screenshot|vision|photo/.test(name) ? 'image'
        : /search|grep|find|glob|recall/.test(name) ? 'search'
        : /write|edit|create|patch|save|apply/.test(name) ? 'write'
        : /read|file|cat|open|list|tree|view/.test(name) ? 'read'
        : /fetch|http|web|browse|url|curl/.test(name) ? 'glob'
        : /code|script|typescript|eval|run|test/.test(name) ? 'code'
        : 'dot';
    }
    return '<svg class="tico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + TOOL_ICON[kind] + '</svg>';
  }
  function toolUpsert(u, quiet) {
    // Refresco suave: sólo se reaplican las cartas nuevas, las que estaban girando o las
    // que quedaron sin contenido. Las que ya están pintadas y completas no se tocan.
    if (SOFT.on) {
      const sid0 = u.toolCallId || u.id || '';
      const el0 = state.tools.get(sid0);
      if (!el0 || el0.querySelector('.spin') || !el0.querySelector('pre')) {
        SOFT.tools.set(sid0, u);
        softPush('tool', sid0);
      }
      return;
    }
    if (!quiet) hideWelcome();
    noteRunActivity();
    closeAllRecs();
    clearStreaming();
    const id = u.toolCallId || u.id || ('tool-' + Date.now());
    let el = state.tools.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = state.replaying ? 'tool' : 'tool in';
      el.innerHTML = '<span class="tool-ic"></span><div class="tool-body"><div class="tool-title"></div></div>';
      msgWrap().appendChild(el);
      state.tools.set(id, el);
      setPill(null);
    }
    const status = u.status || 'pending';
    const rawIn = u.rawInput || {};
    const shortInput = String(rawIn.command || rawIn.path || rawIn.file_path || rawIn.query || rawIn.url || rawIn.pattern || '').split('\n')[0].slice(0, 90);
    const title = u.title || u.kind || shortInput || 'Herramienta';
    const t = el.querySelector('.tool-title');
    t.innerHTML = `${esc(title)}${u.kind && u.kind !== title ? ` <span class="tname">${esc(u.kind)}</span>` : ''}`;
    el.classList.toggle('ok', status === 'completed');
    el.classList.toggle('err', status === 'failed');
    // Auto-correccion: si la carta habia quedado marcada como interrumpida por un sweep
    // prematuro y ahora llega el resultado real, se limpia sola (sin recargar la vista).
    const stale = el.querySelector('.tool-title .tint');
    if (stale && status !== 'pending' && status !== 'in_progress') stale.remove();
    const ic = el.querySelector('.tool-ic');
    ic.innerHTML = status === 'pending' || status === 'in_progress' ? '<span class="spin"></span>' : toolIconSvg(String(u.kind || (rawIn.command ? 'shell' : (rawIn.path || rawIn.file_path) ? 'read' : (rawIn.query || rawIn.pattern) ? 'search' : rawIn.url ? 'glob' : (u.title || ''))).split(/[ /]/)[0], status === 'failed' ? 'failed' : 'ok');
    const texts = [];
    for (const c of u.content || []) {
      if (c && c.type === 'content' && c.content && c.content.type === 'text') texts.push(c.content.text);
      else if (c && c.type === 'diff') texts.push('± ' + (c.path || 'archivo'));
    }
    if (texts.length) {
      let pre = el.querySelector('pre');
      if (!pre) { pre = document.createElement('pre'); el.querySelector('.tool-body').appendChild(pre); }
      const all = texts.join('\n');
      pre.textContent = all.length > 6000 ? all.slice(0, 6000) + '\n…' : all;
      el.classList.add('has-content');
    }
    if (!quiet) scrollBottom();
  }

  // Aplica lo buffereado por el refresco suave, en el orden en que llegó.
  function softApply() {
    const res = { text: 0, tool: 0, user: 0, updated: 0 };
    const midOk = new Set([...document.querySelectorAll('#msg-inner .msg-user')].map((e) => e.dataset.mid).filter(Boolean));
    for (const [tipo, k] of SOFT.order) {
      if (tipo === 'text') {
        const text = SOFT.text.get(k);
        if (text == null) continue;
        const rec = state.msgs.get(k);
        if (rec) {
          if (rec.text === text) continue; // ya está igual: no se toca el DOM
          rec.text = text; rec.lastAppend = 0; rec.live = false; queueRender(rec);
          res.updated++;
        } else {
          streamAppend(k, text, SOFT.kind.get(k)); // burbuja nueva
          res.text++;
        }
      } else if (tipo === 'tool') {
        const u = SOFT.tools.get(k);
        if (u) { toolUpsert(u, true); res.tool++; }
      } else {
        const usr = SOFT.users[k];
        if (!usr) continue;
        if (usr.mid && midOk.has(usr.mid)) continue; // ya estaba pintada
        addUser(usr.text, true, usr.atts, { mid: usr.mid });
        res.user++;
      }
    }
    return res;
  }

  // ¿Quedó alguna herramienta girando y no hay run activo? Es una interrupción real (el
  // run murió sin dejar resultado): sin esto el replay muestra un spinner eterno.
  function sweepInterruptedTools() {
    if (state.busy) return 0;
    let n = 0;
    for (const el of state.tools.values()) {
      const spin = el.querySelector('.spin');
      if (!spin) continue;
      spin.remove();
      el.classList.add('err');
      const t = el.querySelector('.tool-title');
      if (t && !t.querySelector('.tint')) {
        const s = document.createElement('span');
        s.className = 'tint';
        s.textContent = ' · interrumpido (sin resultado)';
        t.appendChild(s);
      }
      n++;
    }
    if (n) WATCH_DBG.interrupted = (WATCH_DBG.interrupted || 0) + n;
    return n;
  }

  // Reverso del sweep: si el run sigue vivo, una carta NO debe quedar marcada como
  // interrumpida (el sweep pudo haber corrido antes de adoptar). Idempotente.
  function unsweepInterruptedTools() {
    let n = 0;
    for (const el of state.tools.values()) {
      const t = el.querySelector('.tool-title .tint');
      if (!t) continue;
      t.remove();
      el.classList.remove('err');
      // El run sigue vivo: la carta tiene que volver a girar (el sweep le saco el spin).
      const ic = el.querySelector('.tool-ic');
      if (ic && !ic.querySelector('.spin')) ic.innerHTML = '<span class="spin"></span>';
      n++;
    }
    return n;
  }
  // Refresco del turno adoptado sin reconstruir el DOM. force = fin de turno (no se
  // posterga por tecleo: el costo ya no depende del tamaño de la conversación).
  async function softResync(force) {
    // (v6.4) Con el hub, el refresco periódico sobra: existía sólo porque una conexión que
    // no arrancó el turno no recibía el streaming (y su messageCount venía congelado).
    if (state.hubWatch === true) return false;
    if (!state.current || !rpc.ready || state.resyncing) return false;
    const now = performance.now();
    if (!force && now - lastTypedAt < SOFT_QUIET_MS) { WATCH_DBG.softDeferred++; return false; }
    if (!force && now - lastSoftAt < SOFT_MIN_MS) { WATCH_DBG.softThrottled++; return false; }
    const box = $('#messages');
    const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    const keepTop = box ? box.scrollTop : 0;
    state.resyncing = true;
    SOFT.on = true; softReset();
    const t0 = performance.now();
    try {
      await rpc.request('session/load', { sessionId: state.current.id, cwd: state.current.cwd || CFG.cwd, mcpServers: [] });
    } catch (e) {
      report('error', 'refresco suave: ' + e.message);
    }
    SOFT.on = false;
    const parsed = softApply();
    flushRender();
    const nInt = sweepInterruptedTools();
    if (box && !atBottom) box.scrollTop = keepTop; else scrollBottom(true);
    const dt = performance.now() - t0;
    lastSoftAt = performance.now();
    // Si el replay del server tarda (sesión grande), espaciamos el próximo refresco: no
    // queremos pedir varios MB al teléfono cada 15 s por un turno adoptado.
    softBackoffMs = dt > 4000 ? 60000 : dt > 1500 ? 30000 : SOFT_REFRESH_MS;
    WATCH_DBG.softBackoffMs = softBackoffMs;
    WATCH_DBG.softResyncs++;
    WATCH_DBG.softMs += dt;
    if (dt > WATCH_DBG.maxSoftMs) WATCH_DBG.maxSoftMs = dt;
    WATCH_DBG.lastSoft = { ms: Math.round(dt), ...parsed, interrupted: nInt };
    report('refresh', 'suave ' + Math.round(dt) + 'ms nuevos: texto=' + parsed.text + ' tool=' + parsed.tool + ' user=' + parsed.user + ' actualizados=' + parsed.updated + ' interrumpidas=' + nInt);
    state.resyncing = false;
    return true;
  }

  function showPermCard(m) {
    hideWelcome();
    noteRunActivity();
    const p = m.params || {};
    const tc = p.toolCall || {};
    const el = document.createElement('div');
    el.className = 'perm';
    const cmd = tc.rawInput && (tc.rawInput.command || tc.rawInput.path) ? String(tc.rawInput.command || tc.rawInput.path) : '';
    const showCmd = cmd && !String(tc.title || '').includes(cmd.slice(0, 32));
    el.innerHTML =
      '<div class="perm-head">🔐 Goose pide permiso para usar una herramienta</div>' +
      `<div class="perm-tool">${esc(tc.title || tc.kind || 'Herramienta')}${showCmd ? ` — <code>${esc(cmd.slice(0, 220))}</code>` : ''}</div>` +
      '<div class="perm-btns"></div>';
    const btns = el.querySelector('.perm-btns');
    const labels = {
      allow_once: ['Permitir una vez', 'primary'],
      allow_always: ['Permitir siempre', ''],
      reject_once: ['Rechazar', 'danger'],
      reject_always: ['Rechazar siempre', 'danger'],
    };
    const order = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
    const candidates = [...(p.options || [])].sort(
      (a, b) => (order.indexOf(a.optionId) + 1 || 9) - (order.indexOf(b.optionId) + 1 || 9)
    );
    for (const opt of candidates) {
      const [label, cls] = labels[opt.optionId] || [opt.name || opt.optionId, ''];
      const b = document.createElement('button');
      b.className = 'pb ' + cls;
      b.textContent = label;
      b.addEventListener('click', () => {
        rpc.respond(m.id, { outcome: { outcome: 'selected', optionId: opt.optionId } });
        el.classList.add('answered');
        btns.querySelectorAll('button').forEach((x) => (x.disabled = true));
        const ans = document.createElement('div');
        ans.className = 'perm-answer';
        ans.textContent = 'Respuesta: ' + label;
        el.appendChild(ans);
      });
      btns.appendChild(b);
    }
    msgWrap().appendChild(el);
    scrollBottom(true);
  }

  function setPill(msg) {
    let p = $('#status-pill');
    if (!msg) { p?.remove(); return; }
    if (!p) { p = document.createElement('div'); p.id = 'status-pill'; p.className = 'pill'; msgWrap().appendChild(p); }
    p.innerHTML = '<span class="spin"></span>' + esc(msg);
    scrollBottom();
  }

  function systemNote(msg) {
    hideWelcome();
    report('sysnote', String(msg).slice(0, 300));
    const el = document.createElement('div');
    el.className = 'sysnote';
    el.textContent = msg;
    msgWrap().appendChild(el);
    scrollBottom(true);
  }

  // ---- readout de contexto/tokens: tiene que decir la SITUACION, no un numero suelto ----
  // El server SI manda contextLimit en usage_update (acp/server.rs build_usage_updates),
  // pero el response de session/prompt trae solo totalTokens: si se pisa el estado con eso,
  // el readout queda en "131.4k tok" y no dice nada. Por eso se MEZCLA (state.usage).
  const COMPACT_RATIO = 0.8; // GOOSE_AUTO_COMPACT_THRESHOLD por defecto: compacta a 80% del limite
  // Modelo y esfuerzo efectivos. OJO: cuando el id termina en -none/-low/-high/-max el
  // esfuerzo lo fija el ALIAS (open_design::selected_effort gana sobre el chip), asi que
  // mostrar solo el chip miente.
  function modelParts() {
    const opts = (state.current && state.current.configOptions) || [];
    const val = (id) => {
      const o = opts.find((x) => x && x.id === id);
      if (!o || !Array.isArray(o.options)) return null;
      const cur = o.options.find((c) => c.value === o.currentValue) || o.options[0];
      return (cur && (cur.name || cur.value)) || null;
    };
    let model = val('model');
    let effort = val('thinking_effort');
    let fromAlias = false;
    const mm = /-(none|low|medium|high|max)$/.exec(String(model || ''));
    if (mm) { effort = mm[1] === 'none' ? 'off' : mm[1]; fromAlias = true; }
    if (!model && !effort && !fromAlias) return null;
    return { model: model || val('provider'), effort, fromAlias };
  }
  function modelSummary() {
    const p = modelParts();
    if (!p) return null;
    return (p.model || 'modelo ?') + (p.effort ? '  ·  esfuerzo: ' + p.effort : '');
  }
  function usageLines() {
    const s = state.usage || {};
    const L = [];
    const m = modelSummary();
    if (m) L.push('Modelo: ' + m);
    if (s.used != null) {
      const pct = s.limit ? Math.round((s.used / s.limit) * 100) : null;
      L.push('Contexto: ' + fmtTok(s.used) + (s.limit ? ' de ' + fmtTok(s.limit) + ' tok (' + pct + '%)' : ' tok (el server no informo limite)'));
      if (s.limit) {
        const trig = Math.round(s.limit * COMPACT_RATIO);
        L.push('Compacta sola a ~' + fmtTok(trig) + ' (' + Math.round(COMPACT_RATIO * 100) + '%)  ·  margen ' + fmtTok(Math.max(0, trig - s.used)) + ' tok');
      }
    }
    if (s.inTok != null || s.outTok != null) L.push('Acumulado: entrada ' + fmtTok(s.inTok || 0) + '  ·  salida ' + fmtTok(s.outTok || 0));
    const mu = s.last;
    if (mu) {
      const b = [];
      if (mu.inputTokens != null) b.push('entrada ' + fmtTok(mu.inputTokens));
      if (mu.outputTokens != null) b.push('salida ' + fmtTok(mu.outputTokens));
      if (mu.cacheReadTokens != null) {
        const den = (mu.inputTokens || 0) + mu.cacheReadTokens;
        if (den > 0) b.push('cache ' + Math.round((mu.cacheReadTokens / Math.max(1, mu.inputTokens || 0)) * 100) + '%');
      }
      if (mu.elapsedMs != null) b.push((mu.elapsedMs / 1000).toFixed(1) + 's');
      if (mu.timeToFirstTokenMs != null) b.push('1er token ' + (mu.timeToFirstTokenMs / 1000).toFixed(1) + 's');
      if (mu.isCompaction) b.push('COMPACTACION');
      if (b.length) L.push('Ultimo paso: ' + b.join('  ·  '));
    }
    if (s.cost != null) L.push('Costo acumulado: ' + fmtCost(s.cost));
    if (!L.length) L.push('Sin datos de uso todavia.');
    return L;
  }
  function resetUsageForSession() {
    const sid = (state.current && state.current.id) || null;
    if (state.usageSid === sid) return;
    state.usageSid = sid;
    state.usage = {};
    renderUsage();
  }
  // ---------- popover de contexto: chico, anclado al readout, estilo Claude ----------
  let usagePop = null;
  function closeUsagePop() { if (usagePop) usagePop.hidden = true; }
  function buildUsagePop() {
    if (usagePop) return usagePop;
    const w = document.createElement('div');
    w.id = 'usage-pop';
    w.hidden = true;
    w.innerHTML =
      '<div class="up-h"><span>Contexto</span><i class="up-verdict"></i><b class="up-pct">--</b></div>' +
      '<div class="up-meter"><i></i><em></em></div>' +
      '<div class="up-sub"></div>' +
      '<div class="up-rows"></div>' +
      '<div class="up-foot"></div>';
    document.body.appendChild(w);
    usagePop = w;
    document.addEventListener('pointerdown', (e) => {
      if (!usagePop || usagePop.hidden) return;
      const a = $('#meta-right');
      if (usagePop.contains(e.target) || (a && a.contains(e.target))) return;
      closeUsagePop();
    }, true);
    window.addEventListener('resize', placeUsagePop);
    window.addEventListener('scroll', placeUsagePop, true);
    return w;
  }
  function placeUsagePop() {
    const w = usagePop;
    const a = $('#meta-right');
    if (!w || w.hidden || !a) return;
    const r = a.getBoundingClientRect();
    const pw = w.offsetWidth, ph = w.offsetHeight;
    let top = r.top - ph - 9;
    const above = top >= 8;
    if (!above) top = r.bottom + 9;
    let left = r.right - pw;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    w.dataset.above = above ? '1' : '0';
    w.style.left = Math.round(left) + 'px';
    w.style.top = Math.round(Math.max(8, top)) + 'px';
  }
  const niceTok = (n) => {
    if (n == null) return '--';
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1000000).toFixed(2).replace(/\.00$/, '') + 'M';
  };
  const popRow = (k, v) => '<div class="up-row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';
  function openUsagePop() {
    const w = buildUsagePop();
    const s = state.usage || {};
    const mp = modelParts() || {};
    const pct = s.limit && s.used != null ? Math.min(100, (s.used / s.limit) * 100) : null;
    const trig = s.limit ? s.limit * COMPACT_RATIO : null;
    const col = pct == null ? 'var(--text-4)' : pct >= COMPACT_RATIO * 100 ? 'var(--danger)' : pct >= 50 ? 'var(--warn)' : 'var(--ok)';
    w.querySelector('.up-pct').textContent = pct == null ? '--' : Math.round(pct) + '%';
    w.querySelector('.up-pct').style.color = col;
    const vd = w.querySelector('.up-verdict');
    vd.textContent = pct == null ? 'sin medir todavia' : pct >= COMPACT_RATIO * 100 ? 'va a compactar' : pct >= 50 ? 'mas de la mitad' : 'holgado';
    const bar = w.querySelector('.up-meter i');
    bar.style.background = col === 'var(--text-4)' ? 'var(--text-4)' : 'linear-gradient(90deg, ' + col + ', ' + col + ')';
    w.querySelector('.up-meter em').style.left = Math.round(COMPACT_RATIO * 100) + '%';
    w.querySelector('.up-sub').innerHTML = s.used == null ? 'todavia sin datos de uso' :
      '<b>' + niceTok(s.used) + '</b> de ' + niceTok(s.limit) + ' tok' + (trig ? '  ·  compacta a ' + niceTok(trig) + ' (' + Math.round(COMPACT_RATIO * 100) + '%)' : '');
    const mu = s.last || {};
    const cachePct = mu.cacheReadTokens != null && (mu.inputTokens || 0) + mu.cacheReadTokens > 0
      ? Math.round((mu.cacheReadTokens / Math.max(1, mu.inputTokens || 0)) * 100) + '%' : '--';
    w.querySelector('.up-rows').innerHTML =
      popRow('ultimo paso', 'entrada ' + niceTok(mu.inputTokens) + '  ·  salida ' + niceTok(mu.outputTokens) +
        (mu.elapsedMs != null ? '  ·  ' + (mu.elapsedMs / 1000).toFixed(1) + 's' : '')) +
      popRow('cache', cachePct + (mu.timeToFirstTokenMs != null ? '  ·  1er token ' + (mu.timeToFirstTokenMs / 1000).toFixed(1) + 's' : '')) +
      popRow('sesion', 'entrada ' + niceTok(s.inTok) + '  ·  salida ' + niceTok(s.outTok)) +
      popRow('margen', s.limit && s.used != null && trig ? niceTok(Math.max(0, trig - s.used)) + ' tok antes de compactar' : '--');
    // DESGLOSE: donde se va la ventana. tool results, MOIM por turno, historial
    // oculto por compactar y el prompt fijo (sistema + esquemas de tools). Las partes
    // las estima el server y suman exactamente el 'usado' de arriba.
    const cbd = Array.isArray(s.contextBreakdown) ? s.contextBreakdown : null;
    if (cbd && cbd.length) {
      const tot = cbd.reduce((a, p) => a + (p.tokens || 0), 0) || 1;
      const sep = '<div class="up-row" style="border-top:1px solid var(--line,#3a3a3a);margin-top:6px;padding-top:6px">'
        + '<span class="k">desglose del contexto</span><span class="v">' + niceTok(tot) + ' tok</span></div>';
      const body = cbd.map((p) => {
        const share = Math.round(((p.tokens || 0) / tot) * 100);
        const d = [p.count ? p.count + ' msj' : null, p.detail || null].filter(Boolean).join(' &middot; ');
        return '<div class="up-row" style="padding-left:10px"><span class="k">' + esc(p.label) + '</span>'
          + '<span class="v">' + niceTok(p.tokens) + ' &middot; ' + share + '%'
          + (d ? '<span style="display:block;font-size:11px;opacity:.62">' + esc(d) + '</span>' : '')
          + '</span></div>';
      }).join('');
      w.querySelector('.up-rows').insertAdjacentHTML('beforeend', sep + body);
    }
    w.querySelector('.up-foot').textContent =
      (mp.model || 'modelo ?') + (mp.effort ? '  ·  esfuerzo ' + mp.effort + (mp.fromAlias ? ' (alias)' : '') : '') + (s.cost != null ? '  ·  ' + fmtCost(s.cost) : '');
    w.hidden = false;
    placeUsagePop();
    bar.style.transition = 'none';
    bar.style.width = '0%';
    requestAnimationFrame(() => { bar.style.transition = ''; bar.style.width = (pct == null ? 0 : pct) + '%'; });
  }
  // Boton flotante 'ir al final': aparece cuando te alejas del ultimo mensaje.
  (function initJumpBottom() {
    const box = $('#messages');
    if (!box) return;
    const btn = document.createElement('button');
    btn.id = 'jump-bottom';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Ir al ultimo mensaje');
    btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" width="17" height="17"><path d="M8 3v10M3.6 8.6 8 13l4.4-4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.addEventListener('click', () => scrollBottom(true));
    const host = document.querySelector('.main') || document.body;
    host.appendChild(btn);
    const sync = () => {
      const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
      btn.classList.toggle('show', gap > 240);
    };
    box.addEventListener('scroll', sync, { passive: true });
    setInterval(sync, 1200);
  })();

  if (!window.__usagePopKeys) {
    window.__usagePopKeys = true;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && usagePop && !usagePop.hidden) { closeUsagePop(); e.stopPropagation(); } }, true);
  }
  function renderUsage() {
    const el = $('#meta-right');
    if (!el) return;
    const dbg = state.usageDbg || (state.usageDbg = { setUsage: 0, setMsgUsage: 0, render: 0, lastSet: null, lastMsg: null });
    dbg.render++;
    const s = state.usage || {};
    if (s.used == null && s.cost == null) { el.textContent = ''; el.removeAttribute('title'); el.removeAttribute('data-level'); return; }
    const pct = s.limit && s.used != null ? Math.round((s.used / s.limit) * 100) : null;
    const flag = pct == null ? '' : pct >= COMPACT_RATIO * 100 ? '! ' : pct >= 50 ? '~ ' : '';
    const parts = [];
    if (pct != null) parts.push(pct + '%');
    if (s.used != null) parts.push(fmtTok(s.used) + (s.limit ? '/' + fmtTok(s.limit) : '') + ' tok');
    if (s.cost != null) parts.push(fmtCost(s.cost));
    el.textContent = flag + parts.filter(Boolean).join('  ·  ');
    el.title = usageLines().join(String.fromCharCode(10)) + String.fromCharCode(10) + String.fromCharCode(10) + 'Toque para ver el detalle en el chat.';
    el.dataset.level = pct == null ? 'na' : pct >= COMPACT_RATIO * 100 ? 'hot' : pct >= 50 ? 'warm' : 'ok';
    el.style.color = pct == null ? '' : pct >= COMPACT_RATIO * 100 ? 'var(--danger, #e5484d)' : pct >= 50 ? 'var(--warn, #d29922)' : '';
    el.style.cursor = 'pointer';
    el.onclick = () => openUsagePop();
  }
  function setUsage(u) {
    const dbg = state.usageDbg || (state.usageDbg = { setUsage: 0, setMsgUsage: 0, lastSet: null, lastMsg: null });
    dbg.setUsage++; dbg.lastSet = u;
    resetUsageForSession(); // si cambiaste de chat, no mezclar el uso de la anterior
    const s = state.usage || (state.usage = {});
    const t = u.used ?? u.totalTokens;
    if (t != null) s.used = t;
    if (u.contextLimit != null) s.limit = u.contextLimit;
    if (u.accumulatedCost != null) s.cost = u.accumulatedCost;
    if (u.cost != null && s.cost == null) s.cost = u.cost;
    if (u.accumulatedInputTokens != null) s.inTok = u.accumulatedInputTokens;
    if (u.accumulatedOutputTokens != null) s.outTok = u.accumulatedOutputTokens;
    // Desglose de que compone el contexto (usage_update -> contextBreakdown, lo manda
    // el server). Se guarda tal cual para que el popover lo muestre cuando se abra.
    if (Array.isArray(u.contextBreakdown) && u.contextBreakdown.length) s.contextBreakdown = u.contextBreakdown;
    renderUsage();
  }
  // message_usage (goose-sdk-types): uso POR PASO, con cache y tiempos. El cliente lo ignoraba.
  function setMsgUsage(u) {
    const dbg = state.usageDbg || (state.usageDbg = { setUsage: 0, setMsgUsage: 0, lastSet: null, lastMsg: null });
    dbg.setMsgUsage++; dbg.lastMsg = u;
    resetUsageForSession();
    const s = state.usage || (state.usage = {});
    if (u) s.last = u;
    renderUsage();
  }

  const stopNote = (sr) => {
    if (!sr || sr === 'end_turn') return;
    const m = {
      cancelled: 'Respuesta detenida.',
      max_tokens: 'Se alcanzó el límite de tokens del modelo.',
      refusal: 'El modelo rechazó la solicitud.',
      max_turn_requests: 'Se alcanzó el límite de pasos con herramientas.',
    };
    systemNote(m[sr] || 'Fin: ' + sr);
  };

  // ---------- sesiones: abrir / crear / borrar estado ----------
  function clearMessages() {
    $('#msg-inner')?.remove();
    $('#status-pill')?.remove();
    hideWelcome();
  }

  function resetTransient() {
    state.msgs.clear();
    state.tools.clear();
    state.attachments = [];
    state.runId = null;
    state.adopted = false;
    // (v6.4) El cursor del hub es por sesión: al cambiar de conversación arranca de cero.
    state.hubCursor = null;
    state.hubWatchSid = null;
    state.steers.clear();
    state.queue = [];
    stopRunWatch();
    renderAttachments();
    finishStream();
    runBarHide();
  }

  async function newSession() {
    if (!rpc.ready) { systemNote('Sin conexión con el backend - reintentando.'); return; }
    detachRunView(); // si había un turno en curso, sigue corriendo en el server
    try {
      const res = await rpc.request('session/new', { cwd: CFG.cwd || undefined, mcpServers: [] });
      state.current = { id: res.sessionId, title: 'Nuevo chat', cwd: CFG.cwd, configOptions: res.configOptions || [], modes: res.modes || {} };
      resetTransient();
      clearMessages();
      showWelcome('new');
      updateTitle(); renderChips(); markActive(res.sessionId);
      localStorage.setItem('gweb.last', res.sessionId);
      closeDrawer();
      $('#input').focus();
      // (v6.4) Sesión nueva: engancharse al hub ya mismo (no hay historial que cargar) para
      // que el primer turno lo vean TODAS las conexiones y no sólo la que lo arranca.
      startHubWatch().catch(() => {});
      refreshSessions();
    } catch (e) {
      systemNote('No se pudo crear la sesión: ' + e.message);
    }
  }

  async function openSession(entry) {
    resetUsageForSession();
    // Con turno en curso se permite cambiar igual: el run sigue en el server y al
    // volver checkAdoptedRun() lo re-adopta (barra + Detener + refresco periódico).
    detachRunView();
    stopRunWatch();
    await renderSession(entry);
    // (v6.4) Engancharse al hub después del load + render: la respuesta trae el run activo
    // (adopción sin sondeo) y el replay de lo que pasó mientras no estábamos. Si el server
    // no tiene watch, startHubWatch cae al camino viejo (checkAdoptedRun).
    await startHubWatch();
    pinBottom(1400);
  }

  // Carga una sesión en pantalla (replay del historial + chips). Sin la guarda de
  // "busy": también la usa el refresco periódico de un turno adoptado.
  // (v6.5) Al abrir un chat hay que aterrizar en el ULTIMO mensaje. Un unico salto al
  // fondo no alcanza: el layout sigue creciendo despues del ultimo append (imagenes,
  // codigo y tablas que se miden recien al hacer flush), asi que el salto queda corto y
  // el usuario aparece mirando mensajes viejos. Se mantiene el fondo durante un ratito
  // (y solo se suelta si el usuario scrollea hacia arriba por su cuenta).
  function pinBottom(ms) {
    const box = $('#messages');
    if (!box) return;
    state.pinUntil = performance.now() + (ms || 1200);
    const release = () => {
      state.pinUntil = 0;
      box.removeEventListener('wheel', release);
      box.removeEventListener('touchstart', release);
      box.removeEventListener('pointerdown', release);
    };
    box.addEventListener('wheel', release, { passive: true });
    box.addEventListener('touchstart', release, { passive: true });
    box.addEventListener('pointerdown', release, { passive: true });
    let ultimaAltura = -1;
    const step = () => {
      if (!state.pinUntil) return;
      if (performance.now() > state.pinUntil) { state.pinUntil = 0; return; }
      // (v6.7) Escribir scrollTop todos los frames obliga a layout: solo si crecio.
      if (box.scrollHeight !== ultimaAltura) { ultimaAltura = box.scrollHeight; box.scrollTop = ultimaAltura; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Cuantos mensajes distintos se pintan de una al abrir un chat (el resto va arriba).
  const REPLAY_TAIL_MSGS = 24;

  // Identidad estable de un update para contar mensajes distintos (sin Math.random, o el
  // mismo update cambiaria de identidad entre llamadas y el corte quedaria mal elegido).
  const uidOf = (u) => u.messageId || u.toolCallId || (u.sessionUpdate + '|' + (u.title || u.kind || ''));

  // (v6.6) Replay en dos fases: se entra mirando el ULTIMO mensaje, no el primero.
  //   fase A: se aplican los ultimos REPLAY_TAIL_MSGS mensajes y se ancla el fondo.
  //   fase B: el resto (mas viejo) se pinta en un contenedor aparte y despues se inserta
  //           ARRIBA del todo, compensando el scroll para que la vista no se mueva.
  // El corte se elige en un limite de mensaje para no partir ninguno al medio.
  async function paintReplayTwoPhase() {
    const buf = state.replayBuf;
    state.replayBuf = null;
    if (!buf || !buf.length) return;
    let seen = new Set(), split = 0;
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
      state.offscreen = document.createElement('div');
      state.offscreen.className = 'msg-inner';
      for (let i = 0; i < split; i++) applyUpdate(buf[i]);
      await drainRender();
      state.replaying = false;
      flushRender();
      const real = $('#msg-inner');
      if (!real) return;
      const box = $('#messages');
      const antes = real.scrollHeight;
      const ref = real.firstChild;
      while (state.offscreen.firstChild) real.insertBefore(state.offscreen.firstChild, ref);
      const delta = real.scrollHeight - antes;
      if (box) box.scrollTop = box.scrollTop + delta; // el historial viejo crece por arriba
    } finally {
      state.offscreen = null;
      state.replaying = false;
      flushRender();
    }
  }

  async function renderSession(entry, opts) {
    const id = entry.sessionId || entry.id;
    state.current = { id, title: entry.title || 'Sesión', cwd: entry.cwd, configOptions: entry.configOptions || [], modes: entry.modes || {} };
    resetTransient();
    clearMessages();
    updateTitle(); markActive(id); closeDrawer();
    localStorage.setItem('gweb.last', id);
    if (!opts || !opts.quiet) setPill('Cargando conversación.');
    if (!SOFT.on) {
      state.replayBuf = []; // (v6.6) se pinta en dos fases al terminar el load
      // Red de seguridad: si la fase doble no llegara a correr (una excepcion en el
      // medio), el buffer se vuelca crudo en vez de dejar la conversacion congelada.
      setTimeout(() => {
        if (!state.replayBuf) return;
        const sobrante = state.replayBuf;
        state.replayBuf = null;
        for (const p of sobrante) { try { applyUpdate(p); } catch (e) {} }
        flushRender();
      }, 8000);
    }
    state.replaying = true;
    try {
      const res = await rpc.request('session/load', { sessionId: id, cwd: state.current.cwd || CFG.cwd, mcpServers: [] });
      if (res && Array.isArray(res.configOptions)) state.current.configOptions = res.configOptions;
      if (res && res.modes) state.current.modes = res.modes;
      renderChips();
    } catch (e) {
      systemNote('No se pudo cargar la sesión: ' + e.message);
    }
    state.replaying = false;
    if (state.replayBuf) await paintReplayTwoPhase(); else await drainRender(); // el replay se pinta por tramos: esperar al último antes de cerrar y scrollear
    clearStreaming(); // el replay nunca debe dejar un cursor de streaming colgado
    flushRender(); // pinta lo que haya quedado pendiente del replay
    setPill(null);
    if (state.msgs.size) hideWelcome();
    else showWelcome('empty', state.current.title);
    updateMetaHints();
    scrollBottom(true);
    pinBottom(1400);
  }
  // ---------- barra de turno: trabajando / detener / terminado ----------
  // (el usuario tiene que poder VER que el agente sigue trabajando y CORTARLO,
  //  incluso si el turno lo arrancó otra conexión o si el WS se reconectó)
  let runStart = 0;
  let runTick = 0;
  let runDoneTimer = 0;
  let cancelTimer = 0;
  const fmtElapsed = (ms) => {
    const s = Math.max(0, ms || 0) / 1000;
    return s < 60 ? s.toFixed(1) + ' s' : Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  };
  const paintRunBar = () => {
    const t = $('#runbar-time');
    if (t && runStart) t.textContent = fmtElapsed(performance.now() - runStart);
  };
  function runBarShow(text) {
    const bar = $('#runbar');
    if (!bar) return;
    clearTimeout(runDoneTimer);
    bar.hidden = false;
    bar.classList.remove('done', 'cancelling');
    $('#runbar-text').textContent = text || 'Goose está trabajando…';
    $('#runbar-stop').hidden = false;
    $('#runbar-stop').disabled = false;
    if (!runStart) runStart = performance.now();
    paintRunBar();
    clearInterval(runTick);
    runTick = setInterval(paintRunBar, 250);
  }
  function runBarHide() {
    const bar = $('#runbar');
    clearInterval(runTick); runTick = 0;
    clearTimeout(runDoneTimer); runDoneTimer = 0;
    clearTimeout(cancelTimer); cancelTimer = 0;
    runStart = 0;
    if (bar) { bar.hidden = true; bar.classList.remove('done', 'cancelling'); }
    const stopBtn = $('#runbar-stop'); if (stopBtn) stopBtn.hidden = true;
  }
  function runBarDone(text, ms) {
    const bar = $('#runbar');
    clearInterval(runTick); runTick = 0;
    clearTimeout(cancelTimer); cancelTimer = 0;
    if (!bar) return;
    bar.hidden = false;
    bar.classList.remove('cancelling');
    bar.classList.add('done');
    $('#runbar-text').textContent = text;
    $('#runbar-time').textContent = fmtElapsed(ms);
    $('#runbar-stop').hidden = true;
    clearTimeout(runDoneTimer);
    runDoneTimer = setTimeout(() => { bar.hidden = true; bar.classList.remove('done'); }, 6000);
  }
  // Marca del fin del turno en la conversación: queda donde terminó el streaming,
  // así se ve aunque la barra de arriba ya se haya ido.
  function turnEndNote(ms) {
    const el = document.createElement('div');
    el.className = 'turn-end';
    el.textContent = 'fin del turno · ' + fmtElapsed(ms);
    msgWrap().appendChild(el);
    scrollBottom(true);
  }
  // Llega actividad del agente sin que este cliente haya mandado nada: hay un run vivo.
  function noteRunActivity() {
    if (state.replaying || state.busy || !state.current) return;
    if (!rpc.ready) return;
    state.adopted = true;
    setBusy(true, 'Turno en curso (lo arrancó otra conexión)');
    report('adopt', 'run adoptado desde otra conexión/reload');
  }
  // El server dice que el run terminó (sesión adoptada): cerramos el turno nosotros.
  function endRun(text) {
    state.adopted = false;
    stopRunWatch();
    if (state.busy) setBusy(false, text);
    // El turno ya cerro (activeRunId=null): recien ahora una carta que sigue girando
    // es una interrupcion real. Con el run vivo no se toca (ver checkAdoptedRun).
    sweepInterruptedTools();
  }
  function stopRun() {
    if (!state.current) return;
    report('cancel', 'UI: detener turno');
    try { rpc.notify('session/cancel', { sessionId: state.current.id }); } catch {}
    const bar = $('#runbar');
    if (bar && !bar.hidden) {
      bar.classList.add('cancelling');
      $('#runbar-text').textContent = 'Deteniendo…';
      $('#runbar-stop').disabled = true;
    }
    systemNote('Cancelando…');
    // Red de seguridad: si el server no cierra el run, no dejamos la barra mintiendo
    // en "Deteniendo…" para siempre — se puede volver a intentar.
    clearTimeout(cancelTimer);
    cancelTimer = setTimeout(() => {
      const b = $('#runbar');
      if (!state.busy || !b || b.hidden) return;
      b.classList.remove('cancelling');
      $('#runbar-text').textContent = 'El corte no se confirmó — probá Detener otra vez';
      $('#runbar-stop').disabled = false;
    }, 12000);
  }

  // ---------- enviar / steering ----------
  // Watchdog de turno HUÉRFANO (caso run muerto en silencio): si estamos "busy" como
  // dueños (no adoptado) y el server ya no tiene run activo, el prompt quedo sin
  // respuesta para siempre -> la consola no acepta mas mensajes. Sondeamos y liberamos.
  let orphanTimer = 0;
  // (v6.4) Con hub esta red de seguridad sigue existiendo pero SIN sondeos caros: se espacia
  // a 30 s y consulta `session/info` (no `steer`). Si no hay run y el prompt no tuvo
  // respuesta, a los ~90 s se libera la consola igual que antes.
  const orphanTickMs = () => (state.hubWatch === true ? 30000 : 15000);
  function startOrphanWatch() {
    clearInterval(orphanTimer);
    HUB.orphanMissAt = 0;
    orphanTimer = setInterval(() => {
      if (state.hubWatch === true) hubOrphanTick(); // camino nuevo: info, sin steer
      else orphanTickLegacy(); // camino viejo, intacto
    }, orphanTickMs());
  }
  async function orphanTickLegacy() {
    if (!state.busy || state.adopted || state.resyncing || !rpc.ready || !state.current) return;
    const probe = await activeRunId().catch(() => ({ known: false, runId: null }));
    if (!state.current || !state.busy || state.adopted) return;
    if (probe.known && !probe.runId) {
      // Doble sonda con 4 s de gracia: evita liberar si la respuesta viene en camino.
      await new Promise((r) => setTimeout(r, 4000));
      if (!state.busy || state.adopted || !state.current) return;
      const again = await activeRunId().catch(() => ({ known: false, runId: null }));
      if (!(again.known && !again.runId)) return;
      // Sin run en el server y sin respuesta al prompt: turno huerfano.
      report('adopt', 'turno huerfano detectado: se libera la consola (prompt sin respuesta)');
      systemNote('El turno anterior quedo sin cerrar (no hay run activo): se libero la consola para seguir.');
      setBusy(false, 'Sin respuesta del turno anterior');
    }
  }
  function stopOrphanWatch() { clearInterval(orphanTimer); orphanTimer = 0; }

  // Cambiar de chat con un turno en curso: el run sigue vivo en el server (al volver,
  // checkAdoptedRun() lo re-adopta: barra + Detener + refresco). Acá solo liberamos la
  // VISTA, sin ceremonias de fin de turno (nada de "fin del turno" ni reenvios).
  function detachRunView() {
    if (!state.busy) return false;
    const sid = state.current && state.current.id;
    report('adopt', 'cambio de chat con turno en curso: sigue corriendo (' + (sid || '?') + ')');
    state.busy = false;
    state.adopted = false;
    state.runId = null;
    runStart = 0;
    stopRunWatch();
    stopOrphanWatch();
    runBarHide();
    $('#btn-send').hidden = false;
    $('#btn-stop').hidden = true;
    $('#btn-attach').classList.remove('busy');
    updateMetaHints();
    return true;
  }

  function setBusy(b, note, startAt) {
    const was = state.busy;
    state.busy = b;
    if (b) startOrphanWatch(); else stopOrphanWatch();
    $('#btn-send').hidden = b;
    $('#btn-stop').hidden = !b;
    $('#btn-attach').classList.toggle('busy', b);
    if (b) {
      if (!was) { runStart = startAt || performance.now(); runBarShow(note); }
    } else {
      const ms = runStart ? performance.now() - runStart : 0;
      runStart = 0;
      state.runId = null;
      finishStream();
      if (was) {
        runBarDone(note || 'Respuesta completa', ms);
        turnEndNote(ms);
        state.adopted = false;
        stopRunWatch();
        settleSteers(); // lo que el server descarto, se reenvia
      }
    }
    updateMetaHints();
    if (!b) flushQueue().catch(() => {}); // lo encolado sale al terminar el turno
  }

  function updateMetaHints() {
    const l = $('#meta-left');
    if (!l) return;
    // (v6.4) Hint del hub: con más de una conexión sobre la misma sesión, el streaming les
    // llega a todas (ya no hay que refrescar a mano en la otra pestaña o el celular).
    const hub = state.hubWatch === true && state.hubWatchers > 1 ? ' · ' + state.hubWatchers + ' conexiones sobre esta sesión' : '';
    if (state.busy) {
      l.innerHTML = 'El agente está trabajando · <b>Enter</b> manda una indicación al vuelo · <b>Detener</b> corta el turno' + esc(hub);
    } else if (state.slashLoaded && state.slash.length) {
      l.textContent = 'Enter envía · Shift+Enter salto de línea · / comandos · Ctrl+K buscar' + hub;
    } else {
      l.textContent = 'Enter envía · Shift+Enter salto de línea · Ctrl+K buscar' + hub;
    }
  }

  const promptBlocks = (text, atts) => {
    const blocks = [];
    if (text) blocks.push({ type: 'text', text });
    for (const a of atts || []) {
      if (a.kind === 'text') {
        blocks.push({ type: 'text', text: `📄 Archivo adjunto «${a.name}» (${a.size || a.text.length} caracteres):\n\n\`\`\`\`\n${a.text}\n\`\`\`\`` });
      } else {
        blocks.push({ type: 'image', mimeType: a.mimeType, data: a.data });
      }
    }
    return blocks;
  };

  async function sendText(text, atts, bubble) {
    const el = bubble || addUser(text, false, atts);
    const sid = state.current && state.current.id; // dueño del turno: si te vas a otro chat, esa vista no se toca
    state.adopted = false;
    setBusy(true, 'Goose está trabajando.');
    let label = 'Respuesta completa';
    let loMandoComoIndicacion = false;
    try {
      const res = await rpc.request('session/prompt', { sessionId: state.current.id, prompt: promptBlocks(text, atts) });
      if (!(state.current && state.current.id === sid)) { report('adopt', 'turno terminó en ' + (sid || '?') + ' con la vista en otro chat'); return; }
      if (res && res.usage && res.usage.totalTokens != null) setUsage({ used: res.usage.totalTokens });
      stopNote(res && res.stopReason);
      const sr = res && res.stopReason;
      if (sr === 'cancelled') label = 'Turno detenido';
      else if (sr && sr !== 'end_turn') label = 'Turno interrumpido (' + sr + ')';
    } catch (e) {
      if (!(state.current && state.current.id === sid)) {
        report('error', 'prompt de ' + (sid || '?') + ' falló con la vista en otro chat: ' + String((e && e.message) || e).slice(0, 140));
        return;
      }
      // El server nombra en el propio error el run que ya está en curso: no es una
      // caída de red, es un turno vivo en otra conexión (pestaña recargada). Lo
      // adoptamos y el texto va como indicación, en vez de perderse en un "Error:".
      const active = /already has (?:an )?active run [`'"]([^`'"]+)[`'"]/i.exec(String((e && e.message) || ''));
      if (active) {
        loMandoComoIndicacion = true;
        const ok = await steerTo(active[1], text, atts, el, 'Turno en curso: tu mensaje va como indicación.');
        label = ok ? 'Tu mensaje fue al turno en curso' : 'No se pudo mandar la indicación al turno en curso';
        if (!ok) systemNote('El turno en curso no aceptó la indicación: probá de nuevo cuando termine.');
      } else {
        label = 'Se cortó la conexión: el turno se interrumpió';
        systemNote('Error: ' + e.message);
      }
    } finally {
      const stillMine = !!(state.current && state.current.id === sid);
      if (stillMine) {
        if (loMandoComoIndicacion && state.busy) {
          // el turno sigue vivo en otra conexión: seguimos en modo adoptado
          runBarShow(ADOPTED_NOTE);
          startRunWatch();
        } else {
          setBusy(false, label);
        }
        flushQueue();
      } else {
        report('adopt', 'turno de ' + (sid || '?') + ' cerrado sin tocar la vista actual');
      }
      refreshSessions();
    }
  }

  async function send() {
    const input = $('#input');
    const text = input.value.trim();
    const atts = state.attachments.slice();
    if (state.busy) return steerOrQueue(text, atts);
    if (!text && !atts.length) return;
    if (!rpc.ready) { systemNote('Sin conexión con el backend - reintentando.'); return; }
    if (!state.current) await newSession();
    if (!state.current) return;
    input.value = ''; autosize(); refreshSlashMenu();
    state.attachments = [];
    renderAttachments();
    await sendText(text, atts);
  }

  // Steering: mensaje que se manda al agente mientras trabaja (session/steer).
  // Si no sabemos cuál es el run, se le pregunta al server antes de decidir: así un
  // mensaje escrito durante un turno adoptado nunca se pierde ni se manda como prompt.
  async function steerOrQueue(text, atts) {
    if (!rpc.ready) { systemNote('Sin conexión con el backend - reintentando.'); return; }
    const attsText = (atts || []).filter((a) => a.kind === 'text');
    if (!text && !attsText.length) {
      systemNote('Para una indicación al vuelo necesito texto (las imágenes van en el próximo mensaje).');
      return;
    }
    const input = $('#input');
    input.value = ''; autosize(); refreshSlashMenu();
    state.attachments = [];
    renderAttachments();
    const el = addUser(text, false, attsText, { queued: true });
    let rid = state.runId;
    if (!rid) {
      const probe = await activeRunId();
      if (probe.runId) { rid = probe.runId; state.runId = rid; state.adopted = true; startRunWatch(); }
    }
    if (rid && (await steerTo(rid, text, attsText, el))) return;
    state.queue.push({ text, atts: attsText });
    setQueuedNote(el, 'se enviará al terminar el turno');
  }

  // Manda una indicación al run indicado y la deja en state.steers para saber si el
  // agente la levantó (eco user_message_chunk con el mismo messageId) o hay que reenviarla.
  async function steerTo(runId, text, atts, el, note) {
    if (!rpc.ready || !state.current) return false;
    try {
      const res = await rpc.request('_goose/unstable/session/steer', {
        sessionId: state.current.id,
        prompt: promptBlocks(text, atts || []),
        expectedRunId: runId,
      });
      const mid = (res && res.messageId) || null;
      if (mid) {
        state.steers.set(mid, { el, text, atts: atts || [] });
        trackPending(mid, text);
      }
      state.runId = runId;
      state.adopted = true;
      startRunWatch();
      setQueuedNote(el, note || 'indicación en cola para el agente.');
      return true;
    } catch (e) {
      report('steer', 'falló: ' + e.message);
      return false;
    }
  }

  function markSteerDelivered(messageId) {
    const info = state.steers.get(messageId);
    if (!info) return;
    state.steers.delete(messageId);
    untrackPending(messageId);
    if (info.el) info.el.classList.remove('queued');
    setQueuedNote(info, 'indicación recibida por el agente');
  }

  async function flushQueue() {
    if (state.busy || !state.queue.length) return;
    if (!rpc.ready) return; // sin backend: la cola espera a la reconexión
    const q = state.queue.slice();
    state.queue = [];
    const text = q.map((x) => x.text).filter(Boolean).join('\n\n');
    const atts = q.flatMap((x) => x.atts || []);
    if (!text && !atts.length) return;
    if (!state.current) return;
    await sendText(text, atts);
  }

  // ---------- turno adoptado: otra conexión, o esta pestaña recargada ----------
  // Al recargar en medio de un turno este cliente NO recibe el streaming: las
  // notificaciones van a la conexión que lanzó el prompt, que murió con la recarga
  // (verificado contra el server real: tools/reload-probe.mjs). Lo que sí se puede:
  // preguntar si hay run activo, mostrar la barra + Detener, mandar indicaciones
  // (session/steer se rutea al dueño del run) y refrescar la conversación a medida
  // que el turno persiste mensajes, sin recargar a mano.
  // Diagnóstico del poll de adopción (para verificar en el teléfono): ticks, session/info,
  // cambios de messageCount y resyncs efectivos (con su costo).
  const WATCH_DBG = { ticks: 0, infos: 0, infoErrs: 0, keys: [], resyncs: 0, resyncMs: 0, maxResyncMs: 0, lastKey: '', prevKey: '', softResyncs: 0, softMs: 0, maxSoftMs: 0, softDeferred: 0, softThrottled: 0, interrupted: 0, lastSoft: null,
    // (v6.4) diagnóstico del hub por sesión (watch / replay / reconexión)
    hubWatches: 0, hubRewatches: 0, hubGaps: 0, hubErrs: 0, hubInfoErrs: 0, hubUnsupported: 0, hubRunStarts: 0, hubOrphanFrees: 0 };
  const RUN_WATCH_MS = 2500;
  let runWatch = 0;
  let watchKey = '';
  let watchSince = 0;
  const ADOPTED_NOTE = 'Turno en curso (lo arrancó otra conexión)';
  const setRunBarText = (t) => { const b = $('#runbar-text'); if (b) b.textContent = t; };

  // ==================== v6.4: watch por sesión (fan-out del hub) ====================
  // El server v4 replica las notificaciones de una sesión a TODAS las conexiones
  // enganchadas (`_goose/unstable/session/watch`): un turno ya no pertenece a la conexión
  // que lo arrancó, así que dos pestañas y el celular ven el mismo streaming y el fin de
  // turno llega como evento (`_goose/unstable/session/update` con activeRunId=null), sin
  // sondeos ni refrescos periódicos. Si el server no tiene el método (v2/v3) se marca
  // hubWatch=false y nada de esto corre: queda el comportamiento viejo (soft-poll +
  // sondeo por steer + orphan watch) tal como estaba.
  const HUB = { text: new Map(), kind: new Map(), gapRecovering: false, orphanMissAt: 0 };

  // El replay del hub se pinta con los MISMOS handlers que un evento vivo (onUpdate /
  // onGooseUpdate), en orden; los chunks de texto se acumulan en HUB.text y se reconcilian
  // acá contra lo que ya está pintado (el session/load pudo traer el mismo mensaje parcial)
  // por prefijo común: nunca se pega el mismo texto dos veces.
  function hubApplyReplayText() {
    for (const [key, text] of HUB.text) {
      const thought = HUB.kind.get(key);
      const rec = state.msgs.get(key);
      if (!rec || rec.closed) { streamAppend(key, text, thought); continue; }
      const shown = rec.text || '';
      let n = 0;
      while (n < shown.length && n < text.length && shown[n] === text[n]) n++;
      if (n < text.length) streamAppend(key, text.slice(n), thought);
    }
    HUB.text.clear(); HUB.kind.clear();
  }

  // ¿El server no implementa el método? (v2/v3) -> fallback al comportamiento viejo.
  function hubMethodUnsupported(e) {
    const txt = String((e && e.message) || '') + ' ' + (e && e.data ? JSON.stringify(e.data) : '');
    return (e && e.code === -32601) || /method not found|not supported|no soportado|unknown method|unsupported/i.test(txt);
  }

  // Estado del run sin tocar `steer` (con hub no se sondea con steer: ese sondeo era el
  // que dejaba 2505 ERROR "no active run to steer" en el log del server).
  async function runIdFromInfo() {
    if (!rpc.ready || !state.current) return { known: false, runId: null };
    try {
      const info = await rpc.request('_goose/unstable/session/info', { sessionId: state.current.id });
      const meta = (info && info.session && info.session._meta) || {};
      if (typeof meta.watcherCount === 'number') state.hubWatchers = meta.watcherCount;
      if (meta.activeRunId === undefined) return { known: false, runId: null };
      return { known: true, runId: meta.activeRunId || null };
    } catch {
      WATCH_DBG.hubInfoErrs++;
      return { known: false, runId: null };
    }
  }

  // Desengancha esta conexión de una sesión (al cambiar de chat o cerrar). Si el server no
  // tiene `unwatch` no pasa nada: el hub poda al watcher cuando muere la conexión.
  async function hubUnwatch(sessionId) {
    try { await rpc.request('_goose/unstable/session/unwatch', { sessionId }); } catch {}
  }

  // ¿La burbuja del usuario ya está pintada con ese messageId? (el load o el propio envío
  // pueden haberla puesto antes de que llegue el eco del hub: no se duplica).
  function userBubbleOnScreen(mid) {
    const nodes = document.querySelectorAll('#msg-inner .msg-user');
    for (let i = nodes.length - 1; i >= 0 && i >= nodes.length - 3; i--) if (nodes[i].dataset.mid === mid) return true;
    return false;
  }

  // El eco del prompt propio (burbuja local sin messageId) ahora también llega como
  // notificación: se le pega el id en vez de pintar una segunda burbuja igual.
  function adoptLocalEcho(mid, text) {
    const nodes = document.querySelectorAll('#msg-inner .msg-user');
    const needle = wordsOf(text);
    for (let i = nodes.length - 1; i >= 0 && i >= nodes.length - 4; i--) {
      const el = nodes[i];
      if (el.dataset.mid) continue;
      const shown = wordsOf(el.textContent);
      if (shown && needle && (shown === needle || needle.startsWith(shown))) { el.dataset.mid = mid; return true; }
    }
    return false;
  }

  // Aplica el replay de la respuesta de watch, en orden, por el mismo camino que un evento
  // vivo. Devuelve true si el hub avisó que truncó el ring (replay_gap).
  function hubApplyReplay(replay) {
    let gap = false;
    state.hubReplay = true;
    HUB.text.clear(); HUB.kind.clear();
    try {
      for (const n of replay || []) {
        if (!n || !n.method) continue;
        if (n.method === '_goose/unstable/session/replay_gap') { gap = true; continue; }
        handleServerMessage(n);
      }
    } finally {
      state.hubReplay = false;
      hubApplyReplayText();
    }
    return gap;
  }

  // Engancha la conexión a la sesión en pantalla. since = último cursor (reconexión) o null
  // (primera vez: el server manda el run en curso desde su inicio).
  // Devuelve 'ok' | 'gap' | 'unsupported' | 'error'.
  async function watchSession(since, opts) {
    if (!state.current || !rpc.ready) return 'error';
    const sid = state.current.id;
    if (state.hubWatchSid && state.hubWatchSid !== sid) {
      const prev = state.hubWatchSid;
      state.hubWatchSid = null; state.hubCursor = null;
      hubUnwatch(prev);
    }
    try {
      // El watch no puede colgar la apertura de sesión: si el server no contesta,
      // caemos al camino viejo (que sí tiene red de seguridad propia).
      const res = await Promise.race([
        rpc.request('_goose/unstable/session/watch', { sessionId: sid, since: since == null ? null : since }),
        new Promise((res2) => setTimeout(() => res2(null), 8000)),
      ]);
      if (res === null) { report('watch', 'session/watch sin respuesta en 8 s: se mantiene el refresco viejo'); return 'unsupported'; }
      if (!(state.current && state.current.id === sid)) { hubUnwatch(sid); return 'ok'; } // cambió de chat mientras respondía
      // Capacidad REAL: el contrato contesta un objeto con `cursor`. Si el server no tiene
      // el método y devuelve null/vacío, no hay watch que valga: comportamiento viejo.
      if (!res || typeof res !== 'object' || typeof res.cursor !== 'number') {
        state.hubWatch = false;
        state.hubWatchSid = null;
        WATCH_DBG.hubUnsupported = 1;
        report('watch', 'respuesta de session/watch sin cursor: se mantiene el refresco viejo');
        return 'unsupported';
      }
      state.hubWatch = true;
      state.hubWatchSid = sid;
      if (res && typeof res.cursor === 'number') state.hubCursor = res.cursor;
      // El hub no manda watcherCount en la respuesta de watch: se lee de session/info.
      if (res && typeof res.watcherCount === 'number') state.hubWatchers = res.watcherCount;
      WATCH_DBG.hubWatches++;
      const gap = hubApplyReplay(res && res.replay);
      // Un cursor que RETROCEDE significa que el hub soltó el ring de la sesión (TTL de
      // inactividad) y volvió a empezar: lo tratamos como replay_gap y recargamos todo.
      const rewound = typeof since === 'number' && typeof res.cursor === 'number' && res.cursor < since;
      // La respuesta manda sobre el replay: es el estado del run AHORA (el replay puede
      // incluir eventos viejos del ring y no debe animar la UI por ellos).
      if (res && res.activeRunId !== undefined) applyActiveRunId(res.activeRunId || null);
      if (!opts || !opts.quiet) report('watch', 'enganchado ' + sid.slice(0, 12) + ' cursor=' + state.hubCursor + ' replay=' + ((res && res.replay && res.replay.length) || 0) + (res && res.activeRunId ? ' run=' + res.activeRunId : ''));
      updateMetaHints();
      return (gap || rewound) ? 'gap' : 'ok';
    } catch (e) {
      if (hubMethodUnsupported(e)) {
        // Server v2/v3: no hay watch. Fallback COMPLETO al comportamiento viejo.
        state.hubWatch = false;
        state.hubWatchSid = null;
        WATCH_DBG.hubUnsupported = 1;
        report('watch', 'server sin _goose/unstable/session/watch: se mantiene el refresco viejo (' + String((e && e.message) || '').slice(0, 120) + ')');
        return 'unsupported';
      }
      WATCH_DBG.hubErrs++;
      report('watch', 'watch falló: ' + String((e && e.message) || e).slice(0, 200));
      return 'error';
    }
  }

  // Recarga completa conservando el turno en curso (igual que resyncAdoptedRun): barra,
  // cronómetro, indicaciones en cola. Se usa cuando el hub truncó su ring.
  async function hubLoadAndRewatch() {
    if (!state.current || !rpc.ready) return 'error';
    const keep = {
      runId: state.runId, adopted: state.adopted, busy: state.busy, start: runStart,
      atts: state.attachments.slice(), queue: state.queue.slice(), steers: [...state.steers.entries()],
    };
    state.hubCursor = null;
    state.resyncing = true;
    try { await renderSession(state.current, { quiet: true }); }
    catch (e) { report('error', 'recarga por hub: ' + e.message); }
    state.runId = keep.runId;
    state.adopted = keep.adopted;
    state.queue = keep.queue;
    state.steers = new Map(keep.steers);
    state.attachments = keep.atts;
    renderAttachments();
    if (keep.busy) {
      runStart = keep.start || performance.now();
      setBusy(true, ADOPTED_NOTE);
      const bar = $('#runbar');
      if (bar && bar.hidden) runBarShow(ADOPTED_NOTE);
    }
    state.resyncing = false;
    return await watchSession(null, { quiet: true });
  }

  // El hub truncó el ring: session/load completo + re-watch desde cero (una sola vez).
  async function hubFullResync() {
    if (HUB.gapRecovering) return false;
    HUB.gapRecovering = true;
    try {
      WATCH_DBG.hubGaps++;
      report('watch', 'replay_gap: session/load completo + re-watch');
      await hubLoadAndRewatch();
      return true;
    } finally { HUB.gapRecovering = false; }
  }

  function onReplayGap(params) {
    const sid = params && params.sessionId;
    if (sid && state.current && sid !== state.current.id) return;
    if (state.hubWatch !== true) return; // sin cursores no hay gap que recuperar
    hubFullResync().catch(() => {});
  }

  // Al reconectar el WS: re-watch con el último cursor para no perderse lo que pasó
  // mientras estábamos caídos.
  async function hubRewatch() {
    if (!state.current || !rpc.ready) return false;
    WATCH_DBG.hubRewatches++;
    const r = await watchSession(state.hubCursor);
    if (r === 'unsupported' || r === 'error') { await checkAdoptedRun(); return false; }
    if (r === 'gap') { await hubFullResync(); return true; }
    if (!state.busy) { sweepInterruptedTools(); flushPendingSteers(); }
    return true;
  }

  // Enganche inicial (después del session/load + render, o al crear la sesión). Si el server
  // no tiene watch o falla la red, cae al camino viejo: checkAdoptedRun (sondeo + hot watch).
  async function startHubWatch() {
    if (state.hubWatch === false) { await checkAdoptedRun(); return false; }
    const r = await watchSession(null);
    if (r !== 'ok' && r !== 'gap') { await checkAdoptedRun(); return false; }
    if (r === 'gap') return await hubFullResync();
    // Equivalente liviano de checkAdoptedRun: el run ya vino en la respuesta de watch; si no
    // hay ninguno, lo que quedó girando en pantalla es una interrupción real.
    if (!state.busy) { sweepInterruptedTools(); flushPendingSteers(); }
    return true;
  }

  // Red de seguridad del hub: consulta `session/info` (NO `steer`) y libera la consola sólo
  // si el server dice que no hay run y el prompt quedó sin respuesta (~90 s de margen).
  async function hubOrphanTick() {
    const probe = await runIdFromInfo();
    if (!state.current || !state.busy || state.adopted) return;
    if (!probe.known || probe.runId) { HUB.orphanMissAt = 0; return; }
    if (!HUB.orphanMissAt) { HUB.orphanMissAt = performance.now(); return; }
    if (performance.now() - HUB.orphanMissAt < 60000) return;
    HUB.orphanMissAt = 0;
    WATCH_DBG.hubOrphanFrees++;
    report('adopt', 'turno huerfano (hub): se libera la consola (prompt sin respuesta)');
    systemNote('El turno anterior quedó sin cerrar (no hay run activo): se liberó la consola para seguir.');
    setBusy(false, 'Sin respuesta del turno anterior');
  }

  // `activeRunId` de la sesión: arranque y fin de turno. Con watch es el ÚNICO aviso de fin
  // para el DUEÑO del prompt (su response puede perderse: reload, socket caído) y también
  // para el turno adoptado. Guarda: un `null` viejo no cierra un turno recién lanzado que
  // todavía no registró su run (no vimos ningún run ni lo adoptamos).
  function applyActiveRunId(rid) {
    const prev = state.runId;
    state.runId = rid || null;
    // Replay: sólo se registra el estado; decide la respuesta de watch (ver watchSession).
    if (state.hubReplay) return state.runId;
    if (rid) {
      if (!prev) WATCH_DBG.hubRunStarts++;
      // Run vivo que no arrancamos nosotros (otra pestaña, el celular, un reload): se adopta
      // (barra + Detener) y el streaming llega igual, porque somos watchers de la sesión.
      if (!state.busy) { unsweepInterruptedTools(); adoptRun(rid, ADOPTED_NOTE); }
      return rid;
    }
    if (!state.busy) return null;
    if (!prev && !state.adopted) return null;
    // Antes esto era sólo para el turno adoptado; con hub vale también para el dueño (un
    // prompt sin respuesta dejaba la consola muda hasta recargar).
    if (state.hubWatch === true || state.adopted) endRun('El turno terminó');
    return null;
  }

  // ¿Hay un run activo en esta sesión, y con qué id? `session/steer` con un
  // expectedRunId imposible: el server valida el run ANTES de tocar al agente, así que
  // no encola nada, y contesta con el run real ("actualRunId") o con "no active run".
  async function activeRunId() {
    if (!rpc.ready || !state.current) return { known: false, runId: null };
    // (v6.4) Con hub el run activo viene en `session/info` y por evento: no se sondea con
    // `steer` (ese sondeo dejaba 2505 ERROR "no active run to steer" en el log del server).
    if (state.hubWatch === true) return runIdFromInfo();
    try {
      const res = await rpc.request('_goose/unstable/session/steer', {
        sessionId: state.current.id,
        prompt: [{ type: 'text', text: '.' }],
        expectedRunId: 'probe' + Math.random().toString(36).slice(2),
      });
      return { known: true, runId: (res && res.runId) || null };
    } catch (e) {
      const d = e && e.data;
      const actual = d && typeof d === 'object' ? d.actualRunId : null;
      if (actual) return { known: true, runId: String(actual) };
      // OJO: el server responde SIEMPRE message:"Invalid params" y pone lo útil en `data`:
      //   sin run activo    -> data = "no active run to steer" (string)
      //   run de otra conexión -> data = { actualRunId: "run_..." }
      // Antes se testeaba `msg` (siempre "Invalid params") y el fin de turno NUNCA se detectaba.
      const dataTxt = typeof d === 'string' ? d : d ? JSON.stringify(d) : '';
      const all = String((e && e.message) || '') + ' ' + dataTxt;
      if (/no active run to steer/i.test(all)) return { known: true, runId: null };
      const mRun = all.match(/run_[0-9a-f-]{6,}/i);
      if (mRun) return { known: true, runId: mRun[0] };
      report('steer', 'sondeo de run falló: ' + (all.trim() || 'error rpc').slice(0, 200));
      return { known: false, runId: null };
    }
  }

  function adoptRun(runId, note, startedAt) {
    state.adopted = true;
    stopOrphanWatch(); // en adoptado vigila watchAdoptedRun
    if (runId) state.runId = runId;
    const text = note || ADOPTED_NOTE;
    if (!state.busy) setBusy(true, text, startedAt);
    else setRunBarText(text); // no pisamos un "Deteniendo…" en curso
    startRunWatch();
  }

  function startRunWatch() {
    // (v6.4) Con watch no hay nada que sondear cada 2,5 s: el fin de turno llega como
    // evento (activeRunId=null) a todas las conexiones enganchadas a la sesión.
    if (state.hubWatch === true) return;
    if (runWatch) return;
    watchSince = Date.now();
    runWatch = setInterval(watchAdoptedRun, RUN_WATCH_MS);
  }

  function stopRunWatch() {
    if (runWatch) clearInterval(runWatch);
    runWatch = 0;
    watchKey = '';
  }

  // Cada ~2,5 s: ¿sigue vivo el run? ¿creció la conversación? (sin recargar a mano)
  async function watchAdoptedRun() {
    const cur = state.current;
    if (!cur || !rpc.ready) return;
    if (Date.now() - watchSince > 6 * 3600 * 1000) { stopRunWatch(); return; }
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
    const info = await rpc.request('_goose/unstable/session/info', { sessionId: cur.id }).then((v) => { WATCH_DBG.infos++; return v; }).catch(() => { WATCH_DBG.infoErrs++; return null; });
    const meta = (info && info.session && info.session._meta) || {};
    const key = meta.messageCount != null ? String(meta.messageCount) + '|' + String(meta.lastMessageAt || '') : '';
    WATCH_DBG.prevKey = watchKey;
    WATCH_DBG.lastKey = key;
    WATCH_DBG.keys.push({ t: Date.now(), key, hasMeta: !!(info && info.session) });
    if (WATCH_DBG.keys.length > 40) WATCH_DBG.keys.shift();
    if (key && watchKey && key !== watchKey) {
      WATCH_DBG.resyncs++;
      await softResync(false);
    }
    // El messageCount que ve una conexión que NO es dueña del run puede venir congelado
    // (medido: 18 polls con la misma clave durante 45 s de herramientas). Por eso además
    // del cambio de clave hay un refresco suave de respaldo.
    if (performance.now() - lastSoftAt > softBackoffMs) await softResync(false);
    if (key) watchKey = key;
  }

  async function endAdoptedRun() {
    await softResync(true); // trae lo último que el turno persistió (sin reconstruir el DOM)
    state.adopted = false;
    state.runId = null;
    if (state.busy) setBusy(false, 'El turno terminó (otra conexión)');
    // Un turno adoptado también descarta indicaciones al cerrar: acá SÍ sabemos que
    // terminó (el sondeo lo confirmó) y la red anda (el resync recién trajo datos):
    // revisamos las indicaciones y reenviamos las que quedaron sin levantar.
    state.suppressSettle = false;
    settleSteers();
  }

  // Recarga la conversación del server conservando el turno adoptado (barra,
  // cronómetro, Detener y las indicaciones en cola).
  // Red de seguridad para Ctrl+F5: el probe del run puede no verlo desde una conexion
  // nueva (medido: watchDbg.ticks=0 y las cartas quedaban marcadas como interrumpidas).
  // Si la SESION estuvo activa hace poco, asumimos que el turno sigue y refrescamos la
  // conversacion cada 2,5s hasta que se enfrie. No depende del probe ni del streaming.
  let hotWatch = 0, hotLast = '', hotIdle = 0;
  function stopHotWatch() { if (hotWatch) clearInterval(hotWatch); hotWatch = 0; }
  async function hotTick() {
    const cur = state.current;
    if (!cur || !rpc.ready) { stopHotWatch(); return; }
    const info = await rpc.request('_goose/unstable/session/info', { sessionId: cur.id }).catch(() => null);
    const meta = (info && info.session && info.session._meta) || {};
    const key = String(meta.messageCount != null ? meta.messageCount : '') + '|' + String(meta.lastMessageAt || '');
    const fresh = meta.lastMessageAt ? (Date.now() - Date.parse(meta.lastMessageAt)) < 90000 : false;
    if (key && key !== hotLast && hotLast) hotIdle = 0;
    else hotIdle++;
    await softResync(true); // el messageCount de una conexion que no es duena del run puede venir CONGELADO
    hotLast = key;
    WATCH_DBG.hotTicks = (WATCH_DBG.hotTicks || 0) + 1;
    if (!fresh && hotIdle > 3) { WATCH_DBG.hotEnds = (WATCH_DBG.hotEnds || 0) + 1; stopHotWatch(); await endAdoptedRun(); }
  }
  function startHotWatch() { if (hotWatch) return; hotIdle = 0; hotLast = ''; hotWatch = setInterval(hotTick, 2500); hotTick(); }
  async function resyncAdoptedRun() {
    if (state.resyncing || !state.current || !rpc.ready) return;
    const keep = {
      runId: state.runId,
      adopted: state.adopted,
      busy: state.busy,
      start: runStart,
      atts: state.attachments.slice(),
      queue: state.queue.slice(),
      steers: [...state.steers.entries()],
    };
    state.resyncing = true;
    try {
      await renderSession(state.current, { quiet: true });
    } catch (e) {
      report('error', 'resync: ' + e.message);
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
      const bar = $('#runbar');
      if (bar && bar.hidden) runBarShow(ADOPTED_NOTE);
    }
    if (keep.adopted) startRunWatch();
    state.resyncing = false;
  }

  // El server descarta las indicaciones que el turno no llegó a consumir
  // (clear_active_run -> discard_pending_steers): acá se reenvían como mensajes.
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
      if (!state.steers.has(mid)) continue; // llegó el eco: el agente la levantó
      state.steers.delete(mid);
      untrackPending(mid);
      const text = (info && info.text) || '';
      const atts = (info && info.atts) || [];
      // OJO: estar en el historial NO prueba que el turno la haya consumido.
      // clear_active_run -> discard_pending_steers tira las steers aceptadas y ya
      // persistidas. Si el server nos dijo que la tenia ENCOLADA (queuedSteer) y no
      // llego el eco, el turno cerro sin leerla: se reenvia como mensaje.
      const serverHeldIt = !!(info && info.serverQueued);
      // Levantada de verdad = respuesta del asistente DESPUÉS de ella en el historial
      // (estar en el historial no alcanza: discard_pending_steers deja steers
      // persistidas sin consumir — caso real 12/10).
      if (text && !serverHeldIt && steerAnsweredInHistory(text)) {
        // Se consumió pero el eco fue a la conexión dueña del run: no se reenvía.
        if (info && info.el) info.el.classList.remove('queued');
        setQueuedNote(info, 'indicación recibida por el agente');
        continue;
      }
      if (info && info.el) info.el.remove();
      if (text || atts.length) state.queue.push({ text, atts });
      requeued += 1;
    }
    if (requeued) {
      systemNote(requeued === 1
        ? 'Una indicación quedó sin respuesta en ese turno: se reenvía como mensaje.'
        : requeued + ' indicaciones quedaron sin respuesta: se reenvían como mensajes.');
      flushQueue();
    }
  }

  // Indicaciones que sobreviven a una recarga (localStorage): si el turno anterior no
  // las consumió, no pueden quedar mudas para siempre.
  const PENDING_KEY = 'gweb.pendingSteers';
  const loadPending = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]') || []; } catch { return []; } };
  const savePending = (list) => { try { localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-12))); } catch {} };
  const trackPending = (mid, text) => { if (!mid) return; savePending([...loadPending().filter((p) => p.mid !== mid), { mid, text, sessionId: state.current ? state.current.id : null, ts: Date.now() }]); };
  const untrackPending = (mid) => savePending(loadPending().filter((p) => p.mid !== mid));

  const wordsOf = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  // ¿El texto ya está en la conversación traída del server? Las burbujas locales "en
  // cola" no cuentan: si el steer se consumió, el server lo persistió como mensaje.
  function textInServerHistory(text) {
    const needle = wordsOf(text).slice(0, 60);
    if (!needle) return false;
    const box = $('#messages');
    if (!box) return false;
    const clone = box.cloneNode(true);
    clone.querySelectorAll('.msg-user.queued, .sysnote, .turn-end, .steer-note').forEach((el) => el.remove());
    return wordsOf(clone.textContent).includes(needle);
  }

  // ¿El turno LEVANTÓ esta indicación? Estar en el historial no alcanza:
  // clear_active_run -> discard_pending_steers deja steers persistidas sin consumir
  // (caso real 12/10: "vos podes sacar screenshots" y "Vamos con todo!!"). Consumida
  // de verdad = aparece en el historial Y hay respuesta del asistente DESPUÉS de ella.
  function steerAnsweredInHistory(text) {
    const needle = wordsOf(text).slice(0, 60);
    if (!needle) return false;
    const box = $('#msg-inner') || $('#messages');
    if (!box) return false;
    const nodes = [...box.querySelectorAll('.msg-user, .msg-a')];
    let lastIdx = -1;
    nodes.forEach((el, i) => {
      if (el.classList.contains('msg-user') && !el.classList.contains('queued')
        && wordsOf(el.textContent).includes(needle)) lastIdx = i;
    });
    if (lastIdx < 0) return false; // ni siquiera quedó persistida
    for (let i = lastIdx + 1; i < nodes.length; i++) {
      if (nodes[i].classList.contains('msg-a')) return true; // hay respuesta después
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
    const seen = new Set();
    for (const p of mine) {
      const text = String(p.text || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      if (steerAnsweredInHistory(text)) { report('steer', 'pendiente ya consumida, no se reenvia: ' + text.slice(0, 40)); continue; } // consumida de verdad (hay respuesta después)
      stale.push(text);
    }
    if (!stale.length) return;
    for (const text of stale) state.queue.push({ text, atts: [] });
    systemNote(stale.length === 1
      ? 'Quedó una indicación sin respuesta del turno anterior: se reenvía como mensaje.'
      : stale.length + ' indicaciones quedaron sin respuesta: se reenvían como mensajes.');
    flushQueue();
  }

  // Al abrir una sesión (arranque, recarga o cambio de sesión): ¿hay un run vivo?
  async function checkAdoptedRun() {
    if (!rpc.ready || !state.current) return false;
    state.suppressSettle = false;
    const probe = await activeRunId();
    if (!state.current) return false;
    if (probe.known && probe.runId) {
      unsweepInterruptedTools(); // el run esta vivo: ninguna carta debe quedar como interrumpida
      adoptRun(probe.runId, 'Turno en curso (seguía corriendo al recargar)');
      systemNote('Este turno ya estaba en curso cuando abriste la página: se sigue con refresco periódico (el streaming en vivo va a la conexión que lo arrancó).');
      return true;
    }
    stopRunWatch();
    // Recien aca se puede decidir: el probe de arriba ya dijo que NO hay run vivo.
    if (!(probe.known && probe.runId)) { const _m = await rpc.request('_goose/unstable/session/info', { sessionId: state.current.id }).then((v) => (v && v.session && v.session._meta) || {}).catch(() => ({})); const _fresh = _m.lastMessageAt ? (Date.now() - Date.parse(_m.lastMessageAt)) < 150000 : false; if (_fresh) { unsweepInterruptedTools(); if (!state.busy) setBusy(true, 'Turno en curso (recuperado tras recargar)'); startHotWatch(); return true; } }
    // Antes esto corria dentro de renderSession, es decir ANTES de adoptar: una carta
    // pendiente de un run que si estaba vivo quedaba marcada como interrumpida.
    sweepInterruptedTools();
    if (!state.busy) flushPendingSteers();
    return false;
  }

  // ---------- chips (config options) ----------
  function renderChips() {
    const wrap = $('#chips');
    wrap.innerHTML = '';
    document.querySelectorAll('body > .menu').forEach((m) => m.remove()); // limpia menús "portal" previos
    const opts = (state.current && state.current.configOptions) || [];
    for (const opt of opts) {
      if (opt.type !== 'select' || !Array.isArray(opt.options) || opt.options.length <= 1) continue;
      const item = document.createElement('div');
      item.className = 'chip-wrap';
      item.dataset.opt = opt.id;
      const btn = document.createElement('button');
      btn.className = 'chip';
      const cur = opt.options.find((o) => o.value === opt.currentValue) || opt.options[0];
      btn.textContent = (cur && (cur.name || cur.value)) || opt.name || opt.id;
      btn.title = opt.name || opt.id;
      const menu = document.createElement('div');
      menu.className = 'menu'; menu.hidden = true;
      menu.innerHTML = `<div class="menu-label">${esc(opt.name || opt.id)}</div>`;
      for (const o of opt.options) {
        const row = document.createElement('button');
        row.className = 'menu-row' + (o.value === opt.currentValue ? ' sel' : '');
        row.innerHTML = `<span>${esc(o.name || o.value)}</span>`;
        row.addEventListener('click', async (e) => {
          e.stopPropagation();
          menu.hidden = true;
          await setConfig(opt.id, o.value);
        });
        menu.appendChild(row);
      }
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasHidden = menu.hidden;
        closeMenus();
        if (wasHidden) openMenu(btn, menu);
      });
      item.append(btn, menu);
      wrap.appendChild(item);
    }
  }

  // Los menús se mueven al <body> al abrirse (patrón portal) y se posicionan
  // con coordenadas fijas: inmunes a contenedores con overflow, máscaras
  // (el scroll de chips en móvil) o contextos de apilado intermedios.
  function openMenu(btn, menu) {
    const r = btn.getBoundingClientRect();
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    menu.hidden = false; // medir con el menú ya visible (si no, offsetHeight = 0)
    const h = menu.offsetHeight;
    let top = r.bottom + 7;
    // Si abajo no hay lugar (fila cerca del borde inferior), el menú se abre hacia arriba:
    // antes quedaba fuera del viewport y no se podía tocar.
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 7);
    menu.style.top = Math.round(top) + 'px';
    menu.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
    menuOpenedAt = Date.now();
  }
  let menuOpenedAt = 0;
  const closeMenus = () => document.querySelectorAll('.menu').forEach((m) => (m.hidden = true));
  document.addEventListener('click', closeMenus);
  window.addEventListener('resize', closeMenus);
  window.addEventListener(
    'scroll',
    (e) => {
      if (e.target && e.target.closest && e.target.closest('.menu')) return; // scrollear dentro del menú no lo cierra
      // Ni el scroll automático que dispara el propio click (scrollIntoView del navegador):
      // si no, el menú de fila se cierra solo antes de poder tocarlo.
      if (Date.now() - menuOpenedAt < 500) return;
      closeMenus();
    },
    true
  );

  async function setConfig(configId, value) {
    if (!state.current) return;
    try {
      const res = await rpc.request('session/set_config_option', { sessionId: state.current.id, configId, value });
      if (res && Array.isArray(res.configOptions)) state.current.configOptions = res.configOptions;
      renderChips();
      refreshSessions();
    } catch (e) {
      systemNote('No se pudo cambiar «' + configId + '»: ' + e.message);
    }
  }

  // ---------- adjuntos ----------
  function renderAttachments() {
    const box = $('#attachments');
    box.innerHTML = '';
    if (!state.attachments.length) { box.hidden = true; return; }
    box.hidden = false;
    state.attachments.forEach((a, i) => {
      const d = document.createElement('div');
      if (a.kind === 'text') {
        d.className = 'att-file';
        d.innerHTML =
          `<span class="att-file-ic">📄</span><div class="att-file-body">` +
          `<div class="att-file-name" title="${esc(a.name)}">${esc(a.name)}</div>` +
          `<div class="att-file-size">${fmtSize(a.size)} · texto</div></div>` +
          `<button class="att-x" aria-label="Quitar">✕</button>`;
      } else {
        d.className = 'att-thumb';
        d.innerHTML = `<img src="${a.url}" alt="${esc(a.name || 'adjunto')}"><button class="att-x" aria-label="Quitar">✕</button>`;
      }
      d.querySelector('.att-x').addEventListener('click', () => { state.attachments.splice(i, 1); renderAttachments(); });
      box.appendChild(d);
    });
  }

  const MAX_ATTACH = 6;
  const MAX_IMAGE = 12 * 1024 * 1024;
  const MAX_TEXT_FILE = 256 * 1024;
  const MAX_TEXT_CHARS = 80000;
  const TEXT_EXT = /\.(txt|text|md|markdown|json|jsonl|csv|tsv|log|yml|yaml|toml|ini|cfg|conf|env|sh|bash|zsh|ps1|bat|cmd|js|mjs|cjs|ts|tsx|jsx|py|rs|go|rb|php|java|kt|kts|c|h|cpp|hpp|cc|cs|swift|sql|html|htm|css|scss|less|xml|svg|diff|patch|recipe|yaml)$/i;
  const isTextFile = (f) => /^text\//.test(f.type || '') || TEXT_EXT.test(f.name || '') || /(^|[\\/])(dockerfile|makefile|readme|license)$/i.test(f.name || '');

  const loadImg = (src) =>
    new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = src;
    });

  async function fileToAttachment(file) {
    if (!/^image\//.test(file.type || '')) return null;
    if (file.size > MAX_IMAGE) { systemNote('Imagen demasiado grande (máx 12 MB).'); return null; }
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(new Error('no se pudo leer el archivo'));
      fr.readAsDataURL(file);
    });
    let mime = (dataUrl.match(/^data:([^;]+)/) || [])[1] || file.type || 'image/png';
    let b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    try {
      const img = await loadImg(dataUrl);
      const maxDim = 1800;
      if (img.width > maxDim || img.height > maxDim || b64.length > 2600000) {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const outMime = mime === 'image/png' && b64.length < 1200000 ? 'image/png' : 'image/jpeg';
        const out = canvas.toDataURL(outMime, 0.85);
        mime = outMime;
        b64 = out.slice(out.indexOf(',') + 1);
      }
    } catch {}
    return { mimeType: mime, data: b64, url: 'data:' + mime + ';base64,' + b64 };
  }

  async function fileToTextAttachment(file) {
    if (file.size > MAX_TEXT_FILE) {
      systemNote(`«${file.name}» es muy grande para adjuntar como texto (máx 256 KB).`);
      return null;
    }
    let text = '';
    try { text = await file.text(); } catch { return null; }
    let clipped = false;
    if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); clipped = true; }
    const size = file.size || text.length;
    return {
      kind: 'text',
      name: file.name || 'archivo.txt',
      size,
      text: clipped ? text + `\n… (recortado: solo se enviaron los primeros ${MAX_TEXT_CHARS} caracteres de ${size} bytes)` : text,
    };
  }

  async function addFiles(files) {
    const list = [...(files || [])];
    if (!list.length) return;
    let rejected = 0;
    for (const f of list) {
      if (state.attachments.length >= MAX_ATTACH) { systemNote(`Máximo ${MAX_ATTACH} adjuntos por mensaje.`); break; }
      let att = null;
      try {
        if (/^image\//.test(f.type || '')) att = await fileToAttachment(f);
        else if (isTextFile(f)) att = await fileToTextAttachment(f);
        else rejected++;
      } catch { rejected++; }
      if (att) state.attachments.push(att);
    }
    if (rejected === 1) systemNote('Solo puedo adjuntar imágenes o archivos de texto.');
    else if (rejected > 1) systemNote(`No adjunté ${rejected} archivos: solo imágenes o texto.`);
    renderAttachments();
  }

  // ---------- drag & drop de archivos sobre la ventana ----------
  function wireDropzone() {
    const dz = $('#dropzone');
    const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      dz.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) dz.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      dz.hidden = true;
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) { closeDrawer(); addFiles(files); }
    });
  }

  // ---------- autocompletado de slash commands ----------
  const slashQuery = () => {
    const v = $('#input').value;
    if (!v.startsWith('/')) return null;
    const m = /^\/([^\s]*)$/.exec(v);
    return m ? m[1] : null; // null => ya eligió comando (hay otro bloque de texto)
  };

  async function ensureSlashCommands() {
    if (state.slashLoaded || state.slashLoading || !rpc.ready) return;
    state.slashLoading = true;
    try {
      const res = await rpc.request('_goose/unstable/slash-commands/list', {
        cwd: CFG.cwd || undefined,
        sessionId: (state.current && state.current.id) || undefined,
      });
      state.slash = (res && res.availableCommands) || [];
      state.slashLoaded = true;
    } catch (e) {
      report('error', 'slash-commands/list: ' + e.message);
      state.slashLoaded = true;
    }
    state.slashLoading = false;
    refreshSlashMenu();
    updateMetaHints();
  }

  function refreshSlashMenu() {
    const box = $('#slash-menu');
    if (!box) return;
    const q = slashQuery();
    if (q === null) { box.hidden = true; state.slashItems = []; return; }
    if (!state.slashLoaded) ensureSlashCommands();
    const needle = q.toLowerCase();
    state.slashItems = state.slash
      .filter((c) => !needle || String(c.name || '').toLowerCase().includes(needle))
      .slice(0, 40);
    const head = `<div class="slash-head"><span>Comandos</span><span>↑↓ · Tab/Enter inserta · Esc cierra</span></div>`;
    box.hidden = false;
    if (!state.slashItems.length) {
      box.innerHTML = head + `<div class="slash-hint">${state.slashLoaded ? `Ningún comando coincide con «/${esc(q)}».` : 'Cargando comandos…'}</div>`;
      return;
    }
    if (state.slashIdx >= state.slashItems.length) state.slashIdx = 0;
    box.innerHTML =
      head +
      state.slashItems
        .map((c, i) => {
          const type = (c._meta && (c._meta.commandType || c._meta.type)) || '';
          const hint = c.input && c.input.hint ? ' · ' + c.input.hint : '';
          return (
            `<button class="slash-item${i === state.slashIdx ? ' sel' : ''}" type="button" data-i="${i}">` +
            `<span class="slash-name">/${esc(c.name)}</span>` +
            `<span class="slash-desc">${esc((c.description || '') + hint)}</span>` +
            (type ? `<span class="slash-type">${esc(type)}</span>` : '') +
            `</button>`
          );
        })
        .join('');
    const sel = box.querySelector('.slash-item.sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  function insertSlash(cmd) {
    if (!cmd) return;
    const input = $('#input');
    input.value = '/' + cmd.name + ' ';
    autosize();
    $('#slash-menu').hidden = true;
    input.focus();
  }

  // Devuelve true si consumió la tecla (menú de comandos abierto).
  function slashKey(e) {
    const box = $('#slash-menu');
    if (!box || box.hidden) return false;
    if (e.key === 'Escape') { box.hidden = true; return true; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!state.slashItems.length) return false;
      e.preventDefault();
      const n = state.slashItems.length;
      state.slashIdx = (state.slashIdx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      refreshSlashMenu();
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      if (!state.slashItems.length) return false;
      e.preventDefault();
      insertSlash(state.slashItems[state.slashIdx]);
      return true;
    }
    return false;
  }

  // ---------- títulos / estado ----------
  function updateTitle() {
    $('#chat-title').textContent = (state.current && state.current.title) || 'Nuevo chat';
    document.title = ((state.current && state.current.title) || 'Goose') + ' · Goose web';
  }
  function setStatus(kind, text) {
    const dot = $('#conn-dot');
    dot.className = 'dot' + (kind ? ' ' + kind : '');
    $('#conn-text').textContent = text;
  }

  // ---------- drawer ----------
  const openDrawer = () => { $('#sidebar').classList.add('open'); $('#overlay').hidden = false; };
  const closeDrawer = () => { $('#sidebar').classList.remove('open'); $('#overlay').hidden = true; };

  // ---------- textarea ----------
  let composing = false; // el IME (Gboard) está armando la palabra
  let composerRaf = 0;
  let lastComposerValue = null;
  // (v6.7) Tecleo en el telefono: leer scrollHeight despues de escribir un estilo obliga a
  // recalcular el layout de TODO el documento (cientos de mensajes) en cada tecla: es el
  // "tardan en llegar los caracteres". Con field-sizing el alto lo resuelve el CSS; sin
  // soporte, se mide como maximo cada 120 ms y siempre que cambie la cantidad de lineas.
  const FIELD_SIZING = (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('field-sizing', 'content'));
  let lastSizeAt = 0;
  let lastComposerLines = -1;
  function autosize(force) {
    const t = $('#input');
    lastComposerValue = t.value; // lo que ya procesamos (usado por scheduleComposer)
    if (FIELD_SIZING) return;
    const now = performance.now();
    const lines = (t.value.match(/\n/g) || []).length;
    if (!force && lines === lastComposerLines && now - lastSizeAt < 120) return;
    lastComposerLines = lines;
    lastSizeAt = now;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 200) + 'px';
  }
  // Un rAF por ráfaga de teclas (y ninguna lectura de layout dentro del evento):
  // así el IME no compite con el autosize ni con el menú de comandos.
  function scheduleComposer() {
    if (composerRaf) return;
    composerRaf = requestAnimationFrame(() => {
      composerRaf = 0;
      const t = $('#input');
      if (t.value === lastComposerValue) return;
      const previo = lastComposerValue || '';
      lastComposerValue = t.value;
      const t0 = performance.now();
      autosize();
      // (v6.7) El menu de comandos se rehace solo si el texto empieza con "/" (o si dejo
      // de empezar): asi escribir texto normal no reconstruye la lista en cada tecla.
      if (t.value.charAt(0) === '/' || previo.charAt(0) === '/') refreshSlashMenu();
      const dt = performance.now() - t0;
      METRICS.composerRuns++; METRICS.composerMs += dt;
      if (dt > METRICS.maxComposerMs) METRICS.maxComposerMs = dt;
    });
  }

  // ---------- arranque ----------
  async function onBoot() {
    $('#conn-host').textContent = CFG.host || '';
    renderChips();
    updateMetaHints();
    resetUsageForSession(); // ya con state.current apuntando a ESTA sesion
    await refreshSessions();
    const last = localStorage.getItem('gweb.last');
    const entry = findSession(last);
    if (entry) await openSession(entry);
    else { clearMessages(); showWelcome('new'); await checkAdoptedRun(); }
    refreshSlashMenu();
    report('boot', 'ok - sesiones=' + state.sessions.length + ' archivadas=' + state.archived.length + ' adoptado=' + state.adopted);
  }

  function wire() {
    // delegación en mensajes: copiar código / copiar mensaje / expandir tool
    $('#messages').addEventListener('click', (e) => {
      const cc = e.target.closest('.copy-code');
      if (cc) {
        const code = cc.parentElement.querySelector('pre code');
        copyText(code ? code.textContent : '').then((ok) => {
          cc.textContent = ok ? '✓ Copiado' : 'No se pudo';
          cc.classList.add('done');
          setTimeout(() => { cc.textContent = 'Copiar'; cc.classList.remove('done'); }, 1400);
        });
        return;
      }
      const mc = e.target.closest('.msg-copy');
      if (mc) {
        const el = mc.parentElement.cloneNode(true);
        el.querySelectorAll('button').forEach((b) => b.remove());
        copyText(el.innerText || el.textContent || '').then((ok) => {
          mc.textContent = ok ? '✓' : 'No';
          mc.classList.add('done');
          setTimeout(() => { mc.textContent = 'Copiar'; mc.classList.remove('done'); }, 1400);
        });
        return;
      }
      const th = e.target.closest('.thought');
      if (th) { th.classList.toggle('open'); return; }
      const tool = e.target.closest('.tool.has-content');
      if (tool) tool.classList.toggle('open');
    });

    $('#btn-new').addEventListener('click', () => newSession()); // con turno en curso: detachRunView adentro (el run sigue en el server)
    $('#btn-menu').addEventListener('click', openDrawer);
    $('#overlay').addEventListener('click', closeDrawer);
    $('#btn-close-drawer').addEventListener('click', closeDrawer);
    $('#btn-send').addEventListener('click', send);
    $('#btn-stop').addEventListener('click', stopRun);
    $('#runbar-stop').addEventListener('click', stopRun);

    const input = $('#input');
    // Tipear en el teléfono: nada de trabajo pesado dentro del evento `input`.
    // (a) se agrupa en un rAF, (b) no se toca el textarea durante la composición del
    // IME — hacerlo rompe el teclado y se pierden caracteres al escribir rápido.
    input.addEventListener('input', () => { lastTypedAt = performance.now(); if (!composing) scheduleComposer(); });
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; lastComposerValue = null; lastTypedAt = performance.now(); scheduleComposer(); });
    input.addEventListener('keydown', (e) => {
      lastTypedAt = performance.now(); // actividad de tecleo: posterga el refresco del DOM
      if (slashKey(e)) return; // el menú de comandos consume flechas/Enter/Tab/Esc
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !composing && e.keyCode !== 229) { e.preventDefault(); send(); }
    });
    input.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) {
        if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
      }
      if (files.length) { e.preventDefault(); addFiles(files); }
    });

    $('#btn-attach').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

    $('#search').addEventListener('input', (e) => { state.filter = e.target.value; renderList(); });
    $('#slash-menu').addEventListener('click', (e) => {
      const it = e.target.closest('.slash-item');
      if (!it) return;
      insertSlash(state.slashItems[Number(it.dataset.i)]);
    });
    $('#session-list').addEventListener('click', (e) => {
      const more = e.target.closest('.sb-more-btn');
      if (more) { e.stopPropagation(); loadMoreSessions(); return; }
      const arch = e.target.closest('.sb-arch-toggle');
      if (arch) { e.stopPropagation(); state.showArchived = !state.showArchived; renderList(); return; }
      const menu = e.target.closest('.sb-more');
      if (menu) {
        e.stopPropagation();
        const row = menu.closest('.sb-row');
        openRowMenu(menu, row.dataset.id, row.dataset.arch === '1');
        return;
      }
      const ren = e.target.closest('.sb-rename');
      if (ren) { e.stopPropagation(); startRename(ren.closest('.sb-row').dataset.id); return; }
      const del = e.target.closest('.sb-del');
      if (del) { e.stopPropagation(); askDelete(del.closest('.sb-row').dataset.id); return; }
      const item = e.target.closest('.sb-item');
      if (!item) return;
      const id = item.parentElement.dataset.id;
      const entry = findSession(id);
      if (entry && (!state.current || state.current.id !== id)) openSession(entry);
      else closeDrawer();
    });

    document.querySelectorAll('.sug').forEach((b) =>
      b.addEventListener('click', () => { input.value = b.textContent; input.focus(); autosize(); })
    );

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMenus();
        closeRowMenus();
        const sm = $('#slash-menu');
        if (sm && !sm.hidden) { sm.hidden = true; return; }
        if ($('#sidebar').classList.contains('open')) closeDrawer();
      }
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        const sb = $('#sidebar');
        if (window.innerWidth <= 880 && !sb.classList.contains('open')) openDrawer();
        $('#search').focus(); $('#search').select();
      }
    });

    window.addEventListener('resize', autosize);
    wireDropzone();
  }

  // Superficie de depuración (LAN, un solo usuario): inspeccionar estado desde la consola
  // y desde los checks automatizados. No expone secretos (el WS ya vive en /config.js).
  window.__gooseWeb = { state, renderUsagePublic: renderUsage, metaRight: () => $('#meta-right'), usageDbg: () => state.usageDbg, usageState: () => state.usage, usageLines: () => usageLines(), usageReset: resetUsageForSession, md: (t) => md(t), drainRender, flushRender, showWelcome, refreshSessions, slashCommands: () => state.slash.slice(), dropSocket: () => { try { rpc.ws.close(); } catch {} }, probeRun: activeRunId, resync: resyncAdoptedRun, adopt: adoptRun, pendingSteers: loadPending, rpc, stopWatch: stopRunWatch, startWatch: startRunWatch, watchTick: watchAdoptedRun, softResync, sweepTools: sweepInterruptedTools, metrics: METRICS, watchDbg: WATCH_DBG, hub: () => ({ soportado: state.hubWatch, sid: state.hubWatchSid, cursor: state.hubCursor, watchers: state.hubWatchers, replay: state.hubReplay }), hubWatchNow: startHubWatch, hubRewatch, hubWatchSession: watchSession, hubUnwatch: () => (state.hubWatchSid ? hubUnwatch(state.hubWatchSid) : null), hubInfo: runIdFromInfo, resetMetrics: () => { METRICS.renders = 0; METRICS.renderMs = 0; METRICS.maxRenderMs = 0; METRICS.composerRuns = 0; METRICS.composerMs = 0; METRICS.maxComposerMs = 0; } };

  wire();
  rpc.connect();
  report('boot', 'app cargada (v6.4+hub+detach+wd+sc)');
})();
