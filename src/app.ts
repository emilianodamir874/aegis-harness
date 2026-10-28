// aegis-web · cliente de chat ACP v3 (sin dependencias): sesiones, streaming,
// permisos con botones, adjuntar imágenes, tool cards, chips de modelo.
import { esc, fmtTok, fmtCost, fmtSize, fmtTps, s0, stepRate, COMPACT_RATIO, compactTrig, sameDay, dayLabel, fmtTime } from './app/format';
import { toolIconSvg, toolKindOf, uiIcon, TOOL_ICON } from './app/icons';
import { md } from './app/markdown';
import { sessionListHtml } from './app/sessions';
import { remoteResultsHtml, emptyRemote } from './app/search';
import { readHeading, readBlock, readClean, ttsUrlFor } from './app/read';
import { blobToWav16k, bytesToBase64 } from './app/audio-wav';
import { abrirAcciones, botonAcciones, cerrarAcciones, wireAccionesGlobales, type ActItem } from './app/acts';
(() => {
  'use strict';
  // Legacy dynamic boundaries: DOM nodes and server payloads remain loosely typed.
  type WebConfig = { acpUrl?: string; cwd?: string; host?: string; version?: string; defaultProvider?: string; defaultModel?: string; authed?: boolean; tunnel?: boolean };
  const CFG = (window as Window & { __AEGIS_APP__?: WebConfig }).__AEGIS_APP__ || {};
  const $ = (s: string): any => document.querySelector(s);

  // ---------- reporter mínimo ----------
  const report = (kind: string, msg: unknown, extra?: Record<string, unknown>) => {
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
  const greeting = () => {
    const h = new Date().getHours();
    // El corte estaba en las 13: a las 12:35 todavia decia "Buenos dias". Desde el mediodia, tardes.
    return h >= 6 && h < 12 ? 'Buenos días' : h >= 12 && h < 20 ? 'Buenas tardes' : 'Buenas noches';
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
  type ActiveSession = { id: string; title?: string; cwd?: string; configOptions?: any[]; modes?: any };
  type WatchState = {
    hubWatch: boolean | undefined;
    hubCursor: number | null;
    hubWatchSid: string | null;
    hubReplay: boolean;
    runId: string | null;
    busy: boolean;
    booted: boolean;
    current: ActiveSession | null;
  };
  const state: WatchState & Record<string, any> = {
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
    hubWatch: undefined, // true = el server implementa _aegis/unstable/session/watch; false = v2/v3
    hubCursor: null, // último cursor del hub para la sesión en pantalla (re-watch al reconectar)
    hubWatchSid: null, // sesión a la que está enganchada esta conexión
    hubWatchers: null, // watcherCount que reportó el server (hint de UI)
    hubReplay: false, // true mientras se aplica el replay de un watch
    remote: emptyRemote(), // coincidencias en el contenido (/search.json)
  };

  // ---------- RPC / WS ----------
  type RpcPending = { res: (value: any) => void; rej: (reason: any) => void };
  type RpcClient = {
    ws: WebSocket | null;
    nextId: number;
    pending: Map<number, RpcPending>;
    backoff: number;
    ready: boolean;
    retrying: number | null;
    connect: () => void;
    request: (method: string, params?: any) => Promise<any>;
    notify: (method: string, params?: any) => void;
    respond: (id: any, result: any) => void;
  };
  const rpc: RpcClient = {
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
            clientCapabilities: { _meta: { aegis: { customNotifications: true, toolCallLabelEnrichment: true } } },
            clientInfo: { name: 'aegis-web', version: '1.3' },
            _meta: { 'aegis/useLoginShellPath': true },
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
              const err = new Error((m.error && m.error.message) || 'error RPC') as Error & { code?: number; data?: unknown };
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
        // Los Invalid params del log no decian que request los producia (33 casos el
        // 14/10) y eran indiagnosticables: el metodo viaja pegado al error.
        this.pending.set(id, {
          res,
          rej: (err) => {
            const m = err && err.message ? err.message : String(err);
            const ya = m.indexOf("[metodo: ") >= 0;
            // Mantener code/data del JSON-RPC para distinguir method not found y run activo.
            if (err && typeof err === 'object') {
              // El servidor manda el motivo real en data (p. ej. "Model file not found: ...").
              // Sin esto la UI solo mostraba "Internal error" y no habia forma de diagnosticar.
              const detalle = err.data == null ? '' : (typeof err.data === 'string' ? err.data : JSON.stringify(err.data)).slice(0, 200);
              const base = ya ? m : m + " [metodo: " + method + "]";
              err.message = detalle && !base.includes(detalle) ? base + ": " + detalle : base;
              rej(err);
            } else rej(new Error(ya ? m : m + " [metodo: " + method + "]"));
          },
        });
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

  // Tarjetas de permiso pendientes por sesion: una confirmacion pedida en otro chat no se pinta
  // aca, se guarda y se muestra cuando esa sesion se abre.
  const permPendientes = new Map<string, any[]>();
  function permPendientesDe(sid: string): any[] {
    if (!permPendientes.has(sid)) permPendientes.set(sid, []);
    return permPendientes.get(sid) as any[];
  }
  function flushPermPendientes(sid: string): void {
    const cola = permPendientes.get(sid);
    if (!cola || !cola.length || state.current?.id !== sid) return;
    permPendientes.delete(sid);
    for (const pendiente of cola) showPermCard(pendiente);
  }

  // Confirmaciones pedidas y nunca respondidas, leidas del store por /pending.json. Cuando el
  // serve se reinicia, la espera muere con el proceso y la tarjeta no vuelve a aparecer; esto es
  // lo unico que hace visible una sesion trabada.
  const pendientesStore = new Map<string, number>();
  let pendientesCargados = 0;

  function pendientesDe(sid: string): number {
    return pendientesStore.get(sid) || 0;
  }

  async function cargarPendientes(): Promise<void> {
    if (Date.now() - pendientesCargados < 60000) return;
    pendientesCargados = Date.now();
    try {
      const respuesta = await fetch('/pending.json', { cache: 'no-store' });
      if (!respuesta.ok) return;
      const datos = await respuesta.json();
      const lista: any[] = Array.isArray(datos && datos.sessions) ? datos.sessions : [];
      const previo = new Set(pendientesStore.keys());
      pendientesStore.clear();
      for (const fila of lista) {
        if (fila && fila.sessionId) pendientesStore.set(String(fila.sessionId), Number(fila.pendientes) || 1);
      }
      const nuevas = [...pendientesStore.keys()].filter((id) => !previo.has(id));
      if (nuevas.length) toast('Hay confirmaciones sin responder en otro chat.', '');
      const cur = state.current;
      if (cur) aplicarAvisoPendientes(cur.id);
    } catch {
      // sin red o sin endpoint: no es un error del chat
    }
  }

  function aplicarAvisoPendientes(sid: string): void {
    const total = pendientesDe(sid);
    if (!total) return;
    const marca = `pendientes-${sid}`;
    if (document.getElementById(marca)) return;
    systemNote(
      `Esta sesión tiene ${total} confirmación${total === 1 ? '' : 'es'} sin responder. ` +
        'El proceso que las esperaba ya no existe (reinicio del serve), así que no se pueden aprobar: ' +
        'lo que quedó pendiente no se ejecutó. Si hace falta, repetí el pedido.',
    );
    const nodo = document.querySelector('#msgs .sys-note:last-of-type');
    if (nodo && nodo instanceof HTMLElement) nodo.id = marca;
  }

  function handleServerMessage(m) {
    if (m.method === 'session/update') return onUpdate(m.params || {});
    if (m.method === '_aegis/unstable/session/update') return onAegisUpdate(m.params || {});
    if (m.method === 'session/request_permission') {
      // La tarjeta de permiso llega por el socket con la sesion que la pidio, no con la que se
      // esta mirando: pintarla sin comparar hacia que apareciera la confirmacion de otro chat en
      // el actual. Se encola por sesion y se muestra al abrirla.
      const sid = (m.params && m.params.sessionId) || '';
      const cur = state.current;
      if (sid && sid !== cur?.id) {
        permPendientesDe(sid).push(m);
        toast('Otra sesión pide una confirmación.', '');
        return;
      }
      // Sin sesión activa ni identificador del pedido, no atribuir la tarjeta al chat abierto.
      if (!cur || !sid) return;
      return showPermCard(m);
    }
    // (v6.4) El hub avisa que truncó su ring: hay que recargar la conversación completa.
    if (m.method === '_aegis/unstable/session/replay_gap') return onReplayGap(m.params || {});
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
    if (state.replayBuf && params.sessionId === state.current?.id) { state.replayBuf.push(params); return; }
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
        if (mid && userBubbleOnScreen(mid)) {
          if (u.content && u.content.type === 'image') adjuntarImagenA(mid, u.content);
          noteResume(cur.id, mid);
          break;
        }
        if (mid && u.content && ((u.content.type === 'text' && adoptLocalEcho(mid, u.content.text)) || (u.content.type === 'image' && adoptLocalImage(mid, u.content)))) { noteResume(cur.id, mid); break; }
        // Rebobinado: del turno marcado en adelante nada lo ve el modelo. El replay llega
        // ordenado, asi que al cruzar ese messageId se oculta todo lo que sigue; el primer
        // mensaje que el usuario manda DESPUES vuelve a ser visible (punto de reanudacion).
        const fromMid = hiddenFromId(cur.id);
        if (mid && fromMid) {
          if (mid === fromMid) state.hideTail = true;
          else if (mid === resumeMid(cur.id)) state.hideTail = false;
          else noteResume(cur.id, mid);
        }
        const ag = u._meta && u._meta.aegis;
        const oculto = ag ? ag.agentVisible !== true : state.hideTail;
        if (u.content && u.content.type === 'text') addUser(u.content.text, true, null, { mid, hidden: oculto });
        else if (u.content && u.content.type === 'image') addUser('', true, [u.content], { mid, hidden: oculto });
        if (oculto) markHiddenTail();
        break;
      }
      case 'agent_message_chunk':
        if (u.content && u.content.type === 'text') {
          chunksTurn++;
          textoDelTurno += u.content.text;
          streamAppend(u.messageId || 'a', u.content.text, false, (u._meta && u._meta.aegis) ? u._meta.aegis.agentVisible !== true : state.hideTail);
          speedChunk(u.content.text, u.messageId);
        }
        break;
      case 'agent_thought_chunk':
        if (u.content && u.content.type === 'text') {
          speedStep(u.messageId, true);
          streamAppend(thoughtKeyFor(u), u.content.text, true, (u._meta && u._meta.aegis) ? u._meta.aegis.agentVisible !== true : state.hideTail);
        }
        break;
      case 'tool_call':
      case 'tool_call_update':
        speedStep(u.messageId, true);
        toolUpsert(u);
        break;
      case 'usage_update':
        setUsage(u);
        break;
      case 'message_usage':
        setMsgUsage(u);
        break;
      case 'available_commands_update':
        if (Array.isArray(u.availableCommands)) {
          state.slash = u.availableCommands;
          state.slashLoaded = true;
          refreshSlashMenu();
        }
        break;
      case 'session_info_update': {
        const g = (u._meta && u._meta.aegis) || {};
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

  function onAegisUpdate(params) {
    const cur = state.current;
    if (!cur) return;
    // Este canal no filtraba por sesion: el arranque y el fin de turno de otro chat se aplicaban
    // al que se estaba mirando.
    if (params.sessionId && params.sessionId !== cur.id) return;
    const u = params.update || {};
    // (v6.4) El arranque y el FIN de turno llegan por acá (`params.aegis.activeRunId`): con
    // el hub es el único aviso cuando el response del prompt se pierde (reload, socket
    // caído) o cuando el turno lo arrancó otra conexión.
    const g = params.aegis || (u._meta && u._meta.aegis) || (params._meta && params._meta.aegis);
    if (g && g.activeRunId !== undefined && (!params.sessionId || params.sessionId === cur.id)) applyActiveRunId(g.activeRunId || null);
    if (params.sessionId !== cur.id) return; // el resto de las notificaciones sí son de esta sesión
    if (u.sessionUpdate === 'usage_update') setUsage(u);
    if (u.sessionUpdate === 'message_usage') setMsgUsage(u);
    if (u.sessionUpdate === 'status_message' && u.status && u.status.type === 'progress' && u.status.message) {
      setPill(u.status.message);
    }
  }

  // ---------- render: sesiones ----------

    // Refresca el estado 'en produccion' de la lista mientras la pestana este visible.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!rpc.ready) return;
    // Con turnos en curso se refresca cada 4 s (para ver en vivo, desde cualquier chat, quien
    // trabaja y quien termino); sin turnos, cada 20 s como antes.
    if (!anyRunning() && Date.now() - lastListPoll < 20000) return;
    lastListPoll = Date.now();
    refreshSessions().catch(() => {});
  }, 4000);

  function renderList() {
    if (state.hold) return; // no pisar un editor/confirm abierto
    const list = $('#session-list');
    if (!list) return;
    // Ids ya presentes en la lista: sirven para no repetir abajo una sesion que solo coincide
    // por titulo (ver remoteResultsHtml).
    const localIds = new Set<string>();
    for (const s of state.sessions) localIds.add(s.sessionId);
    for (const s of state.archived) localIds.add(s.sessionId);
    list.innerHTML = sessionListHtml({
      sessions: state.sessions,
      archived: state.archived,
      filter: state.filter,
      cursor: state.cursor,
      pages: state.pages,
      showArchived: state.showArchived,
      activeId: (state.current && state.current.id) || null,
      isRunning,
      isDoneRecently,
      remoteCount: (state.remote && state.remote.sessions.length) || 0,
      remotePending: !!(state.remote && state.remote.loading),
    }) + remoteResultsHtml(state.remote, (state.current && state.current.id) || null, localIds);
  }

  // ---------- busqueda en el contenido (server) ----------
  // El filtro del sidebar es local e instantaneo (titulos de las sesiones ya cargadas).
  // Con 2+ caracteres se consulta /search.json, que busca en los MENSAJES con el indice
  // FTS5 de sessions.db. Respuesta vieja nunca pisa a la nueva (seq) y el fetch se aborta
  // al cambiar la consulta.
  let remoteTimer = 0;
  let remoteSeq = 0;
  let remoteAbort: AbortController | null = null;

  function resetRemote() {
    clearTimeout(remoteTimer);
    remoteSeq++;
    if (remoteAbort) { remoteAbort.abort(); remoteAbort = null; }
    if (state.remote.q || state.remote.sessions.length || state.remote.loading) {
      state.remote = emptyRemote();
      renderList();
    }
  }

  function scheduleRemoteSearch() {
    const q = String(state.filter || '').trim();
    clearTimeout(remoteTimer);
    if (q.length < 2) { resetRemote(); return; }
    if (q !== state.remote.q) {
      // Otra consulta: lo anterior ya no aplica (no mostrar resultados de la busqueda previa).
      state.remote = { ...emptyRemote(), q, loading: true };
      renderList();
    }
    remoteTimer = setTimeout(() => { void runRemoteSearch(q); }, 250);
  }

  async function runRemoteSearch(q, limit = 20) {
    const seq = ++remoteSeq;
    if (remoteAbort) remoteAbort.abort();
    const ctl = new AbortController();
    remoteAbort = ctl;
    try {
      const r = await fetch('/search.json?q=' + encodeURIComponent(q).slice(0, 300) + '&limit=' + limit, {
        signal: ctl.signal,
        credentials: 'same-origin',
      });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      if (seq !== remoteSeq) return;
      if (data && data._error) throw new Error(String(data._error));
      state.remote = {
        q,
        loading: false,
        sessions: Array.isArray(data && data.results) ? data.results.slice(0, 50) : [],
        totalMatches: Number(data && data.totalMatches) || 0,
        truncated: !!(data && data.truncated),
        unavailable: false,
        limit,
      };
    } catch (e) {
      if (seq !== remoteSeq) return;
      // Proxy sin el endpoint todavia, o el indice fallo: no se muestra la seccion y el
      // filtro local sigue andando. No es un error de la app, no se reporta.
      state.remote = { ...emptyRemote(), q, unavailable: true };
    }
    renderList();
  }

  // ---------- informacion de la conversacion (header) ----------
  // Lo que se necesita LEYENDO un chat: id (para pegarlo en logs/comandos), carpeta completa,
  // fechas, cantidad de mensajes y exportar. Renombrar/archivar/borrar siguen en la fila del
  // sidebar: son gestion, y borrar no gana nada por estar al lado del titulo.
  const chatInfoOpen = () => { const p = $('#chat-info'); return !!p && !p.hidden; };

  function renderChatInfo() {
    const body = $('#ci-body') as HTMLElement | null;
    if (!body) return;
    const cur = state.current;
    if (!cur || !cur.id) {
      body.innerHTML = '<div class="ci-empty">Todavía no hay una conversación abierta.</div>';
      return;
    }
    const entry = findSession(cur.id);
    const meta = (entry && entry._meta) || {};
    const arch = state.archived.find((s) => s.sessionId === cur.id);
    const n = meta.messageCount;
    const fila = (k, v, title?) =>
      `<div class="ci-row"><span class="ci-k">${esc(k)}</span><span class="ci-v"${title ? ` title="${esc(title)}"` : ''}>${esc(v)}</span></div>`;
    // Fecha y hora en una sola expresion (antes se mostraba "22/10 · 2026-10-22").
    const fechaHora = (iso?: string): string => {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
      const p = (n: number) => String(n).padStart(2, '0');
      return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const partes = [];
    partes.push(fila('id', cur.id));
    if (cur.cwd) partes.push(fila('carpeta', cur.cwd, cur.cwd));
    if (n != null) partes.push(fila('mensajes', String(n)));
    if (meta.createdAt) partes.push(fila('creada', fechaHora(meta.createdAt)));
    if (entry && entry.updatedAt) partes.push(fila('actualizada', fechaHora(entry.updatedAt)));
    if (arch) partes.push(fila('estado', 'archivada'));
    body.innerHTML =
      '<div class="ci-meta">' + partes.join('') + '</div>' +
      '<div class="ci-actions">' +
      `<button class="xbtn" type="button" data-ci="copy-id">Copiar ID</button>` +
      (cur.cwd ? '<button class="xbtn" type="button" data-ci="copy-path">Copiar ruta</button>' : '') +
      '<button class="xbtn" type="button" data-ci="export-md">Exportar Markdown</button>' +
      '</div>';
    body.querySelectorAll<HTMLButtonElement>('[data-ci]').forEach((b) => {
      b.addEventListener('click', () => {
        const what = b.getAttribute('data-ci');
        if (what === 'copy-id') copySessionId(cur.id);
        else if (what === 'copy-path' && cur.cwd) copyText(String(cur.cwd)).then((ok) => toast(ok ? 'Ruta copiada.' : 'No se pudo copiar.', ok ? '' : 'err'));
        else if (what === 'export-md') exportSession(cur.id, 'markdown');
      });
    });
  }

  function setChatInfo(v) {
    const p = $('#chat-info');
    const btn = $('#btn-chat-info');
    if (!p) return;
    if (v) {
      renderChatInfo();
      // Se ancla debajo del header real (en movil el header crece con la fila de chips) y
      // alineado con el titulo, sin salirse del viewport.
      const bar = document.querySelector('.topbar') as HTMLElement | null;
      const top = Math.round((bar ? bar.getBoundingClientRect().bottom : 54) + 6);
      const w = Math.min(420, window.innerWidth - 24);
      const anchor = window.innerWidth > 880 && btn ? btn.getBoundingClientRect().left : 8;
      const left = Math.max(8, Math.min(anchor, window.innerWidth - w - 8));
      p.style.top = top + 'px';
      p.style.width = w + 'px';
      p.style.left = Math.round(left) + 'px';
    }
    p.hidden = !v;
    if (btn) btn.setAttribute('aria-expanded', String(!!v));
    if (v) {
      const first = $('#ci-close');
      if (first) first.focus({ preventScroll: true });
    }
  }

  // ---------- acciones por sesión (menú de fila, archivar, exportar) ----------
  function toast(msg, kind?) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    // Anuncio para lectores de pantalla (acciones que no mueven el foco).
    t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    t.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite');
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, kind === 'err' ? 4200 : 2600);
  }

  const closeRowMenus = () => document.querySelectorAll('body > .menu.row-menu').forEach((m) => m.remove());

  function openRowMenu(btn, id, archived) {
    closeMenus(); closeRowMenus();
    const menu = document.createElement('div');
    menu.className = 'menu row-menu';
    const entry = (label, fn, kind?) => {
      const b = document.createElement('button');
      b.className = 'menu-row' + (kind ? ' ' + kind : ''); b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.innerHTML = `<span>${label}</span>`;
      b.addEventListener('click', (e) => { e.stopPropagation(); menu.remove(); fn(); });
      menu.appendChild(b);
    };
    entry('Copiar ID de sesión', () => copySessionId(id));
    entry('Renombrar', () => startRename(id));
    entry('Exportar como Markdown', () => exportSession(id, 'markdown'));
    entry('Exportar como JSON', () => exportSession(id, 'json'));
    if (archived) entry('Desarchivar', () => unarchiveSession(id));
    else entry('Archivar', () => archiveSession(id));
    // Borrar vive SOLO aca (con confirmacion en la fila): antes era una X en cada
    // fila y en tactil quedaba a un toque de distancia.
    menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
    entry('Borrar sesión…', () => askDelete(id), 'danger');
    document.body.appendChild(menu);
    openMenu(btn, menu);
  }

  const findSession = (id) => state.sessions.find((s) => s.sessionId === id) || state.archived.find((s) => s.sessionId === id);

  async function archiveSession(id) {
    try {
      await rpc.request('_aegis/unstable/session/archive', { sessionId: id });
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
      await rpc.request('_aegis/unstable/session/unarchive', { sessionId: id });
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
      const res = await rpc.request('_aegis/unstable/session/export', { sessionId: id, format });
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

  let sessionListGeneration = 0;
  async function refreshSessions() {
    const pages = Math.max(1, state.pages);
    const all = [];
    let cursor = null;
    const running = new Set<string>();
    const generation = ++sessionListGeneration;
    try {
      for (let i = 0; i < pages; i++) {
        const res = await rpc.request('session/list', {
          cursor: cursor || undefined,
          meta: { aegis: { includeLastMessageSnippet: false } },
        });
        all.push(...((res && res.sessions) || []));
        const rmeta = (res && (res._meta || res.meta)) || {};
        for (const id of rmeta.runningSessionIds || []) running.add(String(id));
        cursor = (res && res.nextCursor) || null;
        if (!cursor) break;
      }
      if (generation !== sessionListGeneration) return;
      const previous: Set<string> = state.runningIds || new Set<string>();
      state.runningIds = running;
      state.sessions = all.filter((s) => !(s._meta && s._meta.archivedAt));
      state.archived = all.filter((s) => s._meta && s._meta.archivedAt);
      state.cursor = cursor;
      for (const id of previous) if (!running.has(id)) markRun(id, false);
      for (const id of running) if (!previous.has(id)) markRun(id, true);
      renderList();
    } catch (e) {
      report('error', 'session/list: ' + e.message);
    }
  }

  // Copia el ID de sesion al portapapeles. En http:// de la LAN no hay clipboard API (contexto no
  // seguro), asi que cae a la copia clasica; si tampoco, muestra el ID en pantalla para copiarlo a mano.
  async function copySessionId(id) {
    const texto = String(id || '');
    if (!texto) return;
    let ok = false;
    try { await navigator.clipboard.writeText(texto); ok = true; } catch (e) {}
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = texto;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, texto.length);
        ok = document.execCommand('copy');
        ta.remove();
      } catch (e) {}
    }
    systemNote(ok ? ('ID de sesión copiado: ' + texto) : ('No pude copiar solo; el ID es: ' + texto));
    return ok;
  }

  async function loadMoreSessions() {
    const btn = document.querySelector<HTMLButtonElement>('.sb-more-btn');
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
    row.classList.add('confirming');
    (body as HTMLElement).style.display = 'none';
    const c = document.createElement('div');
    c.className = 'sb-confirm';
    c.innerHTML = '<span class="sb-confirm-t">¿Borrar sesión?</span><button class="ym">Sí</button><button class="nn">No</button>';
    // Con el titulo: borrar sin ver cual era el riesgo real de la X por fila.
    const nombre = (findSession(id) && findSession(id).title) || 'esta sesión';
    (c.querySelector('.sb-confirm-t') as HTMLElement).textContent = '¿Borrar «' + nombre + '»?';
    (c.querySelector('.sb-confirm-t') as HTMLElement).title = nombre;
    (c.querySelector('.ym') as HTMLElement).textContent = 'Borrar';
    (c.querySelector('.nn') as HTMLElement).textContent = 'Cancelar';
    row.appendChild(c);
    c.querySelector('.nn').addEventListener('click', (e) => { e.stopPropagation(); state.hold = null; renderList(); });
    c.querySelector('.ym').addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await rpc.request('session/delete', { sessionId: id }); }
      catch (err) { systemNote('No se pudo borrar: ' + err.message); state.hold = null; renderList(); return; }
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
        try { await rpc.request('_aegis/unstable/session/rename', { sessionId: id, title }); ok = true; }
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
  // ---------- modelo por defecto de los chats nuevos ----------
  // Los selectores de modelo viven en la sesion (configOptions): antes de crear un chat no existen.
  // Lo que si se puede mostrar es con que modelo va a arrancar, que lo define el servidor.
  // ---------- aviso de recorte del replay ----------
  // Al reabrir un chat el servidor no reenvia bloques de mas de REPLAY_MAX_BLOCK (8 KB) y deja
  // "... [recortado: N bytes omitidos del replay]". Se envuelve ese texto para mostrarlo como nota
  // al pie con explicacion: el mensaje guardado esta completo, lo que se recorta es el envio.
  (function wireRecortes() {
    const RE = /…?\s*\[recortado: \d+ bytes omitidos del replay\]/;
    // OJO: el chat escribe parrafo por parrafo, asi que el aviso puede llegar como nodo suelto
    // (no como un contenedor .content nuevo). Se recorren los nodos de TEXTO de lo que se agrego,
    // sin depender de la etiqueta, con una poda barata por texto.
    const marcar = (raiz) => {
      const caja = document.getElementById('messages');
      if (!caja || !raiz) return;
      const objetivos = [];
      if (raiz.nodeType === 1) {
        if (raiz === caja || caja.contains(raiz)) objetivos.push(raiz);
        if (raiz.querySelectorAll) objetivos.push(...raiz.querySelectorAll('*'));
      }
      if (raiz === caja) objetivos.splice(0, Math.max(0, objetivos.length - 400)); // arranque: solo lo ultimo
      // Set: el mismo nodo de texto puede entrar dos veces (su contenedor y el propio padre en el
      // mismo lote). Sin deduplicar, el segundo intento reemplazaba un nodo ya reemplazado y tiraba
      // "Cannot read properties of null (reading 'replaceChild')".
      const textos = new Set<Text>();
      for (const o of objetivos) {
        if (!o.textContent || o.textContent.indexOf('[recortado:') === -1) continue;
        if (o.closest && o.closest('.replay-cut')) continue;
        const w = document.createTreeWalker(o, NodeFilter.SHOW_TEXT);
        let t;
        while ((t = w.nextNode())) textos.add(t);
      }
      {
        for (const tn of textos) {
          if (!tn.parentNode) continue; // ya reemplazado en esta misma pasada
          const m = RE.exec(tn.nodeValue || '');
          if (!m) continue;
            const span = document.createElement('span');
            span.className = 'replay-cut';
            span.textContent = m[0].trim();
            span.title = 'El servidor no reenvía bloques de más de 8 KB al reabrir el chat, así que esta parte no viajó. El mensaje guardado está completo.';
            const antes = tn.nodeValue.slice(0, m.index);
            const despues = tn.nodeValue.slice(m.index + m[0].length);
            const frag = document.createDocumentFragment();
            if (antes.trim()) frag.appendChild(document.createTextNode(antes.trim() + ' '));
            frag.appendChild(span);
          if (despues.trim()) frag.appendChild(document.createTextNode(' ' + despues.trim()));
          tn.parentNode.replaceChild(frag, tn);
        }
      }
    };
    const arrancar = () => {
      marcar(document);
      const caja = document.getElementById('messages');
      if (!caja) return;
      new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) marcar(n);
      }).observe(caja, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar, { once: true });
    else arrancar();
  })();

  function pintaModeloPorDefecto() {
    const el = document.getElementById('default-model-chip');
    if (!el) return;
    const hayChat = !!(state.current && state.current.id);
    const base = String((CFG && CFG.defaultModel) || '');
    const effort = String((CFG as any && (CFG as any).defaultEffort) || '');
    // El effort es parte del modo en que arranca el chat: mostrarlo evita que el chip diga
    // "deepseek-v4.1-flash" cuando en realidad corre con effort max.
    const modelo = base && effort ? `${base} · effort ${effort}` : base;
    // Si ya hay chips elegibles (cache), el chip informativo sobra.
    const hayChips = document.querySelectorAll('#chips .chip').length > 0;
    if (hayChat || !modelo || hayChips) {
      if (!el.hidden) { el.hidden = true; el.textContent = ''; }
      return;
    }
    if (el.hidden || el.textContent !== modelo) {
      el.hidden = false;
      el.textContent = modelo;
      el.title = 'Modelo por defecto de los chats nuevos (lo define el servidor). Al abrir un chat se cambia con los selectores de la barra.';
    }
  }

  (function wireModeloPorDefecto() {
    const arrancar = () => {
      state.pendingConfig = leerPendientes();
      pintaModeloPorDefecto();
      // Barato y sin acoplarse a los muchos lugares que cambian de sesion: solo lee el estado.
      setInterval(pintaModeloPorDefecto, 3000);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar, { once: true });
    else arrancar();
  })();

  // Contexto del chat vacio: donde va a trabajar y con que modelo. Evita el
  // primer mensaje de prueba "¿en qué carpeta estás?".
  function renderWelcomeMeta() {
    const el = $('#welcome-meta');
    if (!el) return;
    const cwd = (state.current && state.current.cwd) || CFG.cwd || '';
    const chips = document.querySelectorAll('#chips .chip-wrap');
    let modelo = CFG.defaultModel || '';
    for (const w of chips) {
      if (w.getAttribute('data-opt') === 'model') { const c = w.querySelector('.chip'); if (c && c.textContent) modelo = c.textContent.trim(); }
    }
    const dflt = document.getElementById('default-model-chip');
    if (!modelo && dflt && dflt.textContent) modelo = dflt.textContent.trim();
    const parts = [];
    if (cwd) parts.push('<span class="wm" title="' + esc(cwd) + '"><span class="wm-k">carpeta</span>' + esc(baseName(cwd)) + '</span>');
    if (modelo) parts.push('<span class="wm"><span class="wm-k">modelo</span>' + esc(modelo) + '</span>');
    el.innerHTML = parts.join('');
    el.hidden = !parts.length;
  }
  function showWelcome(mode, title?) {
    const w = $('#welcome');
    if (!w) return;
    renderWelcomeMeta();
    state.welcomeMode = mode || 'new';
    const h1 = $('#welcome-h1');
    const sub = w.querySelector('.welcome-sub');
    if (state.welcomeMode === 'empty') {
      if (h1) h1.textContent = 'Sesión sin mensajes';
      if (sub) sub.textContent = (title ? `«${title}» ` : 'Esta sesión ') + 'todavía no tiene mensajes. Escribí abajo para arrancar la conversación.';
    } else {
      if (h1) h1.textContent = greeting();
      if (sub) sub.textContent = 'Aegis está listo. Puede leer y editar archivos de esta máquina, correr comandos y buscar en la web.';
    }
    w.hidden = false;
  }
  const hideWelcome = () => { $('#welcome')?.setAttribute('hidden', ''); };
  const scrollBottom = (force?) => {
    if (state.replaying) return; // durante el replay medimos una sola vez, al final
    const m = $('#messages');
    if (force || state.pinUntil > performance.now() || m.scrollHeight - m.scrollTop - m.clientHeight < 140) m.scrollTop = m.scrollHeight;
  };

  // ---------- objetivo del chat (/goal y /grind) ----------
  // El serve guarda el objetivo como extension data de la sesion (GoalState: goal/grind) y no se lo
  // manda al cliente, asi que se deduce de la conversacion: manda el ultimo "/goal <texto>" del
  // usuario, "/goal off|clear|none" lo borra, y "/goal" pelado (consulta) no cambia nada.
  // Se engancha en addUser, unico embudo de mensajes del usuario (los propios y los del historial):
  // asi, al recargar la conversacion, el chip se reconstruye solo.
  function goalFromText(text) {
    const s = String(text == null ? '' : text).trim();
    const m = s.match(/^\/(goal|grind)(?:\s+([\s\S]*))?$/i);
    if (!m) return null;
    const kind = m[1].toLowerCase();
    const params = String(m[2] || '').trim();
    if (!params) return { action: 'none', kind };
    if (/^(off|clear|none)$/i.test(params)) return { action: 'clear', kind };
    return { action: 'set', kind, goal: params };
  }

  function noteGoalFrom(text) {
    const r = goalFromText(text);
    if (!r) return;
    if (r.action === 'set') { state.goal = r.goal; state.grind = r.kind === 'grind' ? r.goal : null; }
    else if (r.action === 'clear') { state.goal = null; state.grind = null; }
    renderGoalBar();
    // Un /goal nuevo (o su limpieza) cambia la historia del chat: si el popover esta abierto, se
    // actualiza sin que el usuario tenga que refrescar.
    // Tras un /goal (o su limpieza) se re-consulta al servidor: el chip se corrige solo en un
    // segundo si el estado real no coincide con lo que se acaba de escribir.
    if (r.action !== 'none') fetchGoals(true);
  }

  function renderGoalBar() {
    const bar = document.getElementById('goalbar');
    if (!bar) return;
    const g = state.goal;
    if (!g) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    bar.innerHTML = '';
    const tag = document.createElement('span');
    tag.className = 'goalbar-tag';
    tag.textContent = state.grind ? 'Objetivo (a fondo)' : 'Objetivo';
    const txt = document.createElement('span');
    txt.className = 'goalbar-text';
    txt.textContent = g;
    txt.title = g;
    const x = document.createElement('button');
    x.type = 'button';
    x.id = 'goalbar-x';
    x.className = 'goalbar-x';
    x.textContent = '×';
    x.title = 'Quitar el objetivo (/goal off)';
    x.setAttribute('aria-label', 'Quitar el objetivo');
    x.addEventListener('click', () => { sendText('/goal off'); });
    bar.append(tag, txt, x);
  }

  // El boton de rebobinar necesita el messageId del server. Se agrega al pintar el replay y
  // tambien cuando el eco del hub le pega el id a una burbuja local (ver adoptLocalEcho): antes
  // habia que recargar para poder rebobinar el ultimo mensaje.
  function addRewindBtn(el) {
    if (!el || el.querySelector('.rewind-btn')) return;
    const rw = document.createElement('button');
    rw.type = 'button';
    rw.className = 'rewind-btn';
    rw.title = 'Rebobinar a este mensaje (el modelo deja de ver de aca en adelante)';
    rw.setAttribute('aria-label', 'Rebobinar a este mensaje');
    rw.textContent = '↺';
    el.appendChild(rw);
  }
  function identifyUserBubble(el: HTMLElement | null, mid: string) {
    if (!el || !el.isConnected || !mid || (el.dataset.mid && el.dataset.mid !== mid)) return false;
    el.dataset.mid = mid;
    if (!el.classList.contains('queued')) addRewindBtn(el);
    return true;
  }
  // Un mensaje con texto + imagen llega en dos chunks con el mismo messageId. El primero crea la
  // burbuja; el segundo hay que pegarlo en esa misma burbuja en vez de descartarlo.
  function adjuntarImagenA(mid, content) {
    if (!content || !content.data || !content.mimeType) return false;
    const el = document.querySelector('.msg-user[data-mid="' + (window.CSS && CSS.escape ? CSS.escape(mid) : mid) + '"]');
    if (!el) return false;
    if (el.querySelector('img[data-dl-img="1"]')) return true;
    const img = document.createElement('img');
    img.dataset.dlImg = '1';
    img.src = 'data:' + content.mimeType + ';base64,' + content.data;
    img.alt = 'adjunto';
    img.className = 'att-img';
    img.dataset.dlImg = '1';
    el.appendChild(img);
    return true;
  }

  function addUser(text, replay, atts, opts?) {
    noteGoalFrom(text);
    // Durante un refresco suave no se toca el DOM: se bufferea y se aplica al final
    // (sólo las burbujas nuevas; las que ya están pintadas se saltan por messageId).
    if (SOFT.on && replay && !(opts && opts.local)) {
      SOFT.users.push({ text, atts, mid: (opts && opts.mid) || '', hidden: !!(opts && opts.hidden) });
      softPush('user', SOFT.users.length - 1);
      return null;
    }
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'msg-user' + (opts && opts.queued ? ' queued' : '') + (opts && opts.hidden ? ' hidden-from-agent' : '');
    if (!replay) el.classList.add('in');
    if (opts && opts.mid) el.dataset.mid = opts.mid;
    let html = text ? md(text) : '';
    for (const a of atts || []) {
      if (a && a.kind === 'text') html += `<div class="att-note">📄 ${esc(a.name)}</div>`;
      else if (a && a.data && a.mimeType) html += `<img class="att-img" src="data:${esc(a.mimeType)};base64,${a.data}" alt="${esc(a.name || 'adjunto')}">`;
    }
    el.innerHTML = html;
    if (opts && opts.mid && !opts.queued) addRewindBtn(el);
    msgWrap().appendChild(el);
    scrollBottom(replay);
    return el;
  }

  // ---- rebobinar a un mensaje anterior -------------------------------------
  // El modelo deja de ver desde ese mensaje en adelante (nada se borra: el
  // transcript queda entero, atenuado) y el texto vuelve al composer para
  // editarlo y reenviarlo. Mismo mecanismo que el /rewind del CLI.
  const aegisMeta = (u) => ((u && u._meta && u._meta.aegis) || {});

  // ---- estado de rebobinado por sesion ---------------------------------------
  // El serve NO manda `agentVisible: false` cuando un mensaje quedo oculto: directamente omite
  // el campo (verificado con una sonda: los ocultos llegan sin `_meta.aegis.agentVisible`).
  // Como `undefined !== false`, al re-renderizar (soft refresh, recarga, hub) los mensajes
  // rebobinados volvian a aparecer y el segundo rebobinado no limpiaba nada. Guardamos el
  // messageId del turno rebobinado y, como el replay llega en orden, todo lo que venga de ahi
  // en adelante se oculta (asi tambien se cubren las respuestas, que no llevan dataset.mid).
  function hiddenFromKey(sid) { return 'aegis.hiddenFrom.' + sid; }
  function hiddenFromId(sid) {
    try { return localStorage.getItem(hiddenFromKey(sid)) || ''; } catch { return ''; }
  }
  function setHiddenFrom(sid, mid) {
    if (!sid || !mid) return;
    try { localStorage.setItem(hiddenFromKey(sid), mid); } catch {}
  }
  function clearHiddenFrom(sid) {
    if (!sid) return;
    try { localStorage.removeItem(hiddenFromKey(sid)); } catch {}
    state.hideTail = false;
  }
  function isHiddenMid(sid, mid) {
    const from = hiddenFromId(sid);
    return !!(from && mid && from === mid);
  }
  // Un rebobinado oculta del turno marcado en adelante, pero lo que el usuario mande DESPUES
  // vuelve a ser conversacion visible. Guardamos el messageId de ese reenvio ("punto de
  // reanudacion") para que el replay no lo oculte tambien.
  function resumeMid(sid) {
    try { return localStorage.getItem('aegis.resume.' + sid) || ''; } catch { return ''; }
  }
  function noteResume(sid, mid) {
    if (!sid || !mid) return;
    const from = hiddenFromId(sid);
    if (from && mid !== from && !resumeMid(sid) && !state.replaying) setResume(sid, mid);
  }
  function setResume(sid, mid) {
    if (!sid) return;
    try { mid ? localStorage.setItem('aegis.resume.' + sid, mid) : localStorage.removeItem('aegis.resume.' + sid); } catch {}
  }

  // Atenua la cola que el modelo dejo de ver y la mete en una banda plegable.
  //
  // Regla del producto (2026-10-28): lo que se oculta a la IA NUNCA se oculta al usuario.
  // Antes los mensajes rebobinados se borraban del DOM y quedaba solo una linea de marca: el
  // usuario perdia de vista su propia conversacion. Ahora las filas se conservan enteras,
  // dentro de `.rw-band`, atenuadas y con un encabezado que dice que el modelo no las ve.
  // La banda se pliega solo si el usuario lo pide (y ese estado se recuerda por sesion).
  function rwOpenKey(sid) { return 'aegis.rwOpen.' + (sid || 'nuevo'); }
  function rwOpen(sid) {
    try { return localStorage.getItem(rwOpenKey(sid)) !== '0'; } catch { return true; }
  }
  function rwSetOpen(sid, open) {
    try { localStorage.setItem(rwOpenKey(sid), open ? '1' : '0'); } catch {}
  }
  function rwLabel(n) {
    return n === 1 ? 'El modelo no ve este mensaje' : 'El modelo no ve estos ' + n + ' mensajes';
  }
  function markHiddenTail() {
    const inner = $('#msg-inner');
    if (!inner) return;
    const sid = (state.current && state.current.id) || '';
    // 1) Desarmar lo que hubiera: los nodos vuelven a su lugar y la banda desaparece.
    //    Asi la funcion es idempotente y se puede llamar en cada refresco suave.
    for (const band of [...inner.querySelectorAll('.rw-band')]) {
      const body = band.querySelector('.rw-band-body');
      if (body) while (body.firstChild) inner.insertBefore(body.firstChild, band);
      band.remove();
    }
    const kids = [...inner.children];
    const first = kids.findIndex((k) => k.classList.contains('hidden-from-agent'));
    if (first < 0) {
      for (const k of kids) k.classList.remove('hidden-tail', 'rw-boundary', 'rw-muted');
      return;
    }
    let last = first;
    for (let i = kids.length - 1; i >= first; i--) {
      if (kids[i].classList.contains('hidden-from-agent')) { last = i; break; }
    }
    const ocultos = kids.slice(first, last + 1) as HTMLElement[];
    const open = rwOpen(sid);
    const band = document.createElement('div');
    band.className = 'rw-band rw-marker';
    band.dataset.count = String(ocultos.length);
    band.classList.toggle('collapsed', !open);
    band.innerHTML =
      '<button class="rw-band-head" type="button" aria-expanded="' + (open ? 'true' : 'false') + '">'
      + uiIcon('eyeOff', { size: 13, cls: 'rw-band-ico' })
      + '<span class="rw-band-t">' + esc(rwLabel(ocultos.length)) + '</span>'
      + '<span class="rw-band-hint">siguen guardados en la sesión</span>'
      + uiIcon('chevron', { size: 12, cls: 'rw-band-chev' })
      + '</button>'
      + '<div class="rw-band-body"></div>';
    inner.insertBefore(band, ocultos[0]);
    const body = band.querySelector('.rw-band-body') as HTMLElement;
    for (const k of ocultos) { k.classList.add('rw-muted'); body.appendChild(k); }
    const head = band.querySelector('.rw-band-head') as HTMLButtonElement;
    head.addEventListener('click', () => {
      const next = !band.classList.contains('collapsed');
      band.classList.toggle('collapsed', next);
      head.setAttribute('aria-expanded', String(!next));
      rwSetOpen(sid, !next);
      if (!next) body.querySelector<HTMLElement>(':scope > *')?.scrollIntoView({ block: 'nearest' });
    });
  }

  // Un solo interruptor para ver/esconder el ultimo tramo oculto (Ctrl+Alt+H y el menu).
  function toggleHiddenBand(force?: boolean) {
    const band = document.querySelector<HTMLElement>('#msg-inner .rw-band');
    if (!band) { systemNote('No hay mensajes ocultos al modelo en esta conversación.'); return false; }
    const head = band.querySelector<HTMLButtonElement>('.rw-band-head');
    const abierto = !band.classList.contains('collapsed');
    if (force === undefined ? true : force !== abierto) head?.click();
    return true;
  }

  function askRewind(el) {
    if (!el || el.querySelector('.rw-confirm')) return;
    if (state.busy) { toast('Espera a que termine el turno para rebobinar.', 'err'); return; }
    const c = document.createElement('div');
    c.className = 'rw-confirm';
    c.innerHTML = '<span>Rebobinar aca?</span><button class="ym" type="button">Si</button><button class="nn" type="button">No</button>';
    el.appendChild(c);
    c.querySelector('.nn').addEventListener('click', (e) => { e.stopPropagation(); c.remove(); });
    c.querySelector('.ym').addEventListener('click', async (e) => { e.stopPropagation(); c.remove(); await rewindTo(el); });
  }

  async function rewindTo(el) {
    const mid = el && el.dataset.mid;
    const cur = state.current;
    if (!mid || !cur) return;
    try {
      const res = await rpc.request('_aegis/unstable/session/rewind', { sessionId: cur.id, messageId: mid });
      // Persistimos el turno rebobinado: si el transcript se re-renderiza (soft refresh,
      // recarga), el replay vuelve a ocultar de aca en adelante. Sin esto el segundo
      // rebobinado no limpiaba nada porque el server no marca los ocultos.
      setHiddenFrom(cur.id, mid);
      setResume(cur.id, '');
      // Todo lo que esta pintado desde esta burbuja ya no lo ve el modelo; lo que
      // llegue despues si, asi que se marca solo lo que hay en pantalla ahora.
      const inner = $('#msg-inner');
      if (inner) {
        let seen = false;
        for (const k of inner.children) {
          if (k === el) seen = true;
          if (seen) k.classList.add('hidden-from-agent');
        }
      }
      markHiddenTail();
      if (res && res.text) {
        const input = document.getElementById('input') as HTMLTextAreaElement | null;
        if (input) { input.value = res.text; autosize(); refreshSlashMenu(); input.focus(); }
      }
      systemNote('Rebobinado: se ocultaron ' + ((res && res.hidden) || 0) + ' mensaje(s) desde aca (el modelo no los ve). El texto quedo en el composer para editarlo.');
    } catch (err) {
      toast('No se pudo rebobinar: ' + ((err && err.message) || err), 'err');
    }
  }

  // ---- regenerar la ultima respuesta ----------------------------------------
  // Rebobina al ultimo turno del usuario (back: 1) y lo reenvia solo: el usuario quiere otra
  // respuesta, no editarla. El turno viejo queda oculto igual que en un rebobinado normal.
  async function regenerateLast() {
    const cur = state.current;
    if (!cur) return;
    if (state.busy) { toast('Espera a que termine el turno para regenerar.', 'err'); return; }
    try {
      const res = await rpc.request('_aegis/unstable/session/rewind', { sessionId: cur.id, back: 1 });
      if (!res || !res.text) { toast('No hay un turno para regenerar.', 'err'); return; }
      const inner = $('#msg-inner') as HTMLElement | null;
      const users = inner ? [...inner.querySelectorAll<HTMLElement>(':scope > .msg-user')] : [];
      const lastUser = users[users.length - 1];
      if (lastUser && lastUser.dataset.mid) setHiddenFrom(cur.id, lastUser.dataset.mid);
      setResume(cur.id, '');
      if (inner) {
        let seen = false;
        for (const k of inner.children) {
          if (k === lastUser) seen = true;
          if (seen) k.classList.add('hidden-from-agent');
        }
      }
      markHiddenTail();
      state.hideTail = false;
      await sendText(res.text);
      systemNote('Regenerando: la respuesta anterior quedo oculta para el modelo (sigue guardada en la sesion).');
    } catch (err) {
      toast('No se pudo regenerar: ' + ((err && err.message) || err), 'err');
    }
  }
  document.addEventListener('click', (e) => {
    const btn = e.target && (e.target as Element).closest && (e.target as Element).closest('.rewind-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    askRewind(btn.closest('.msg-user'));
  });

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
  const dirty = new Set<any>();
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
      { const rd = rec.el.querySelector('.act-btn'); if (rd) rd.dataset.read = readBlock(rec.text) ? '1' : ''; }
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
    for (const r of new Set<any>(state.msgs.values())) { r.closed = true; r.live = false; }
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

  // ---- acciones de una respuesta (un solo disparador, acciones adentro) ---------
  // Antes cada respuesta podia cargar tres botones flotando sobre el texto (Copiar, Escuchar,
  // Regenerar). Ahora hay un solo ⋯ y el menu se arma al abrirlo, asi sabe si hay bloque de
  // lectura, si es la ultima respuesta y si se puede regenerar.
  function copiarMensaje(el: HTMLElement) {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('button').forEach((b) => b.remove());
    return copyText(clone.innerText || clone.textContent || '');
  }
  function escucharTexto(txt: string) {
    const limpio = readClean(txt);
    if (!limpio) return;
    const partes: string[] = [];
    const re = /[^.!?\u2026]+[.!?\u2026]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(limpio))) { const p = m[0].trim(); if (p.length > 2) partes.push(p); }
    if (!partes.length) return;
    audStop();
    for (const p of partes) AUD.q.push(p);
    audNext();
  }
  function esRespuestaFinal(el: HTMLElement) {
    if (el.querySelector('.thought') || el.classList.contains('hidden-from-agent')) return false;
    const todas = [...document.querySelectorAll<HTMLElement>('#msg-inner > .msg-a')].filter((x) => !x.querySelector('.thought'));
    return todas[todas.length - 1] === el;
  }
  function accionesDeMensaje(el: HTMLElement, rec: any, thought: boolean): ActItem[] {
    const texto = String((rec && rec.text) || '');
    const out: ActItem[] = [
      { label: 'Copiar', icon: uiIcon('copy', { size: 13 }), run: () => { void copiarMensaje(el); } },
    ];
    if (!thought) {
      const bloque = readBlock(texto);
      if (bloque) out.push({ label: 'Escuchar el bloque', icon: uiIcon('voice', { size: 13 }), hint: 'Para escuchar', run: () => escucharTexto(bloque) });
      // Sin bloque, la prosa sin codigo se puede leer igual (es lo que hace el manos libres).
      if (!bloque && readClean(texto).length >= 120) out.push({ label: 'Escuchar', icon: uiIcon('voice', { size: 13 }), run: () => escucharTexto(texto) });
      if (esRespuestaFinal(el)) {
        out.push({ label: 'Regenerar', icon: uiIcon('refresh', { size: 13 }), hint: 'ultima respuesta', run: () => { void regenerateLast(); } });
      }
    }
    return out;
  }

  function streamAppend(key, text, thought, hidden?) {
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
    // (2026-10-15) El hub puede re-entregar notificaciones desde un cursor viejo y el provider
    // reemitir el texto ACUMULADO en vez de un delta. Si lo que llega ya esta pintado en este
    // mismo key se descarta; si es un superconjunto se pinta solo el delta. Sin esto la respuesta
    // se veia DUPLICADA, y peor: si un tool habia cerrado la caja, el texto repetido abria una
    // caja NUEVA aparte (la respuesta entera dos veces). Los umbrales evitan comerse un chunk
    // legitimo que por casualidad sea prefijo de lo ya pintado.
    if (rec && rec.text) {
      const prev = String(rec.text);
      const inc = String(text == null ? '' : text);
      if (inc && inc.length >= 12 && prev === inc) return;
      if (inc && inc.length > prev.length && inc.startsWith(prev)) { text = inc.slice(prev.length); if (!text) return; }
      else if (inc && inc.length >= 40 && prev.startsWith(inc)) return;
    }
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
      el.className = 'msg-a' + (hidden ? ' hidden-from-agent' : '');
      const body = document.createElement('div');
      body.className = thought ? 'thought' : 'content';
      el.appendChild(body);
      // Un solo disparador por respuesta: copiar, escuchar (con sus bloques como submenú) y
      // regenerar viven adentro. Antes eran hasta tres botones flotando sobre el mensaje.
      el.appendChild(botonAcciones(thought ? 'razonamiento' : 'respuesta', () => accionesDeMensaje(el, rec, thought)));
      msgWrap().appendChild(el);
      rec = { el, body, text: '', dirty: false, closed: false, live: false, lastAppend: 0 };
      (el as any).__rec = rec;
      state.msgs.set(key, rec);
      if (thought) state.thoughtRec = rec;
      if (!thought) curStream = el;
    }
    rec.text += text;
    // Fase del turno: el pensamiento y la respuesta se distinguen en la barra sin leer el texto.
    if (!state.replaying) phaseSet(thought ? 'thinking' : 'writing');
    // Lectura en voz alta: solo el texto de respuesta (no el pensamiento, no lo oculto, no el replay).
    if (!thought && !hidden && !state.replaying) readPump(key, rec.text);
    rec.lastAppend = performance.now();
    rec.live = !state.replaying; // durante un replay se pinta una sola vez, al final
    queueRender(rec);
    if (!thought && rec.el !== curStream) { clearStreaming(); curStream = rec.el; }
    // Durante un replay del historial no hay streaming real: si se marcara acá,
    // el último mensaje reproducido queda con el cursor pegado para siempre.
    if (!state.replaying) { rec.el.classList.add('in'); if (!thought) rec.el.classList.add('streaming'); }
    scrollBottom();
  }

  function toolUpsert(u, quiet?) {
    // Refresco suave: sólo se reaplican las cartas nuevas, las que estaban girando o las
    // que quedaron sin contenido. Las que ya están pintadas y completas no se tocan.
    if (SOFT.on) {
      const sid0 = u.toolCallId || u.id || '';
      const el0 = state.tools.get(sid0);
      if (!el0 || el0.dataset.state === 'run' || !el0.querySelector('pre')) {
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
    // La identidad del call viene del protocolo, no de un selector CSS interpolado.
    if (u.toolCallId) el.dataset.toolCallId = String(u.toolCallId);
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
    // El icono del tipo se queda durante la ejecucion: asi se lee que esta corriendo sin
    // perder de vista que herramienta es. El estado va como clase para que el CSS anime
    // (pulso mientras corre, trazo que se dibuja al completar, sacudida corta si falla).
    // El kind del protocolo llega vacio o con nombres genericos ("running", "tool"): si no
    // resuelve a un icono propio, se infiere del payload (command -> shell, path -> read,
    // query -> search, url -> web). Asi la tarjeta dice que herramienta es aun cuando el
    // server no la clasifique.
    const payloadKind = rawIn.command ? 'shell'
      : rawIn.old_string || rawIn.new_string ? 'edit'
      : rawIn.path || rawIn.file_path ? 'read'
      : rawIn.query || rawIn.pattern || rawIn.glob ? 'search'
      : rawIn.url ? 'glob'
      : rawIn.todos || rawIn.plan ? 'plan'
      : '';
    const declared = String(u.kind || '').split(/[ /]/)[0];
    const kindOf = toolKindOf(declared) !== 'dot' ? declared : (payloadKind || 'dot');
    const running = status === 'pending' || status === 'in_progress';
    const st: 'run' | 'ok' | 'err' = running ? 'run' : status === 'failed' ? 'err' : 'ok';
    el.dataset.state = st;
    el.dataset.kind = kindOf || 'dot';
    phaseSet(st === 'run' ? 'tool' : 'thinking', title);
    ic.innerHTML = toolIconSvg(kindOf, st);
    // Etiqueta de estado para el lector de pantalla: el color y el anillo no se oyen.
    ic.setAttribute('role', 'img');
    ic.setAttribute('aria-label', (st === 'run' ? 'en curso: ' : st === 'err' ? 'falló: ' : 'listo: ') + (kindOf || 'herramienta'));
    el.dataset.step = st === 'run' ? 'trabajando' : st === 'err' ? 'error' : 'listo';
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
      // El contenido de la herramienta se recorta a cierta altura y no habia forma de ver el resto:
      // si el bloque desborda, se agrega un boton para expandirlo (y volver a plegarlo).
      requestAnimationFrame(() => {
        if (!el.isConnected || el.querySelector('.tool-more')) return;
        if (pre.scrollHeight <= pre.clientHeight + 8) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tool-more';
        btn.textContent = 'Ver todo';
        btn.title = 'Mostrar el contenido completo de esta herramienta';
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const abierto = el.classList.toggle('expandido');
          btn.textContent = abierto ? 'Ver menos' : 'Ver todo';
        });
        el.querySelector('.tool-body').appendChild(btn);
      });
    }
    if (!quiet) scrollBottom();
  }

  // Aplica lo buffereado por el refresco suave, en el orden en que llegó.
  function softApply() {
    const res = { text: 0, tool: 0, user: 0, updated: 0 };
    const midOk = new Set([...document.querySelectorAll<HTMLElement>('#msg-inner .msg-user')].map((e) => e.dataset.mid).filter(Boolean));
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
        addUser(usr.text, true, usr.atts, { mid: usr.mid, hidden: usr.hidden });
        res.user++;
      }
    }
    markHiddenTail();
    return res;
  }

  // ¿Quedó alguna herramienta corriendo y no hay run activo? Es una interrupción real (el
  // run murió sin dejar resultado): sin esto el replay quedaría con el anillo girando para
  // siempre. El estado vive en `data-state`, no en un spinner hijo: la carta se marca por el
  // atributo y el icono se repinta con el trazo de fallo.
  function sweepInterruptedTools() {
    if (state.busy) return 0;
    let n = 0;
    for (const el of state.tools.values()) {
      if (el.dataset.state !== 'run') continue;
      el.dataset.state = 'err';
      el.dataset.step = 'interrumpido';
      el.classList.add('err');
      const ic = el.querySelector('.tool-ic');
      if (ic) ic.innerHTML = toolIconSvg(el.dataset.kind || 'dot', 'err');
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
      // El run sigue vivo: la carta vuelve a su estado de ejecución con su propio icono.
      el.dataset.state = 'run';
      el.dataset.step = 'trabajando';
      const ic = el.querySelector('.tool-ic');
      if (ic) ic.innerHTML = toolIconSvg(el.dataset.kind || 'dot', 'run');
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

  // Tarjetas de permiso vivas, por id de request. Sirven para no duplicar la tarjeta si el
  // hub reenvia el pedido y para expirarlas cuando el turno termina sin respuesta.
  const permCards = new Map<string, { el: HTMLElement; answered: boolean }>();

  function permMarkAnswered(el: HTMLElement, text: string) {
    el.classList.add('answered');
    // El turno deja de estar esperando al usuario: la barra vuelve a la fase de trabajo.
    phaseSet('tool');
    el.querySelectorAll<HTMLButtonElement>('.pb').forEach((b) => { b.disabled = true; });
    let ans = el.querySelector<HTMLElement>('.perm-answer');
    if (!ans) {
      ans = document.createElement('div');
      ans.className = 'perm-answer';
      ans.setAttribute('role', 'status');
      ans.setAttribute('aria-live', 'polite');
      el.appendChild(ans);
    }
    ans.textContent = text;
  }

  // El turno termino: una tarjeta sin responder ya no se puede contestar (el hub cerro el
  // pedido). Se marca y se deshabilitan los botones para no dejar controles muertos.
  function expirePermCards(reason: string) {
    for (const [key, c] of permCards) {
      if (!c.answered && c.el.isConnected) permMarkAnswered(c.el, 'Sin respuesta: ' + reason);
      permCards.delete(key);
    }
  }

  // Diff de lineas por LCS acotado: alcanza para revisar un write/edit antes de aprobarlo y no
  // arrastra una dependencia nueva. Arriba de 400x400 lineas cae a un resumen con conteos.
  function lineDiff(antes, despues) {
    const a = String(antes || '').split('\n');
    const b = String(despues || '').split('\n');
    if (a.length > 400 || b.length > 400) {
      return { lines: null, resumen: a.length + ' lineas -> ' + b.length + ' lineas (demasiado grande para diff linea a linea)' };
    }
    const n = a.length;
    const m = b.length;
    const dp = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    let quitadas = 0;
    let puestas = 0;
    while (i < n && j < m && out.length < 400) {
      if (a[i] === b[j]) {
        out.push(' ' + a[i]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push('-' + a[i]);
        quitadas++;
        i++;
      } else {
        out.push('+' + b[j]);
        puestas++;
        j++;
      }
    }
    while (i < n && out.length < 400) {
      out.push('-' + a[i]);
      quitadas++;
      i++;
    }
    while (j < m && out.length < 400) {
      out.push('+' + b[j]);
      puestas++;
      j++;
    }
    return { lines: out, resumen: '+' + puestas + ' / -' + quitadas };
  }

  async function renderWriteDiff(cardEl, toolCall) {
    const ri = (toolCall && toolCall.rawInput) || {};
    const kind = String(toolCall && (toolCall.kind || toolCall.title) || '').toLowerCase();
    const escribe = /write|edit|str_replace/.test(kind);
    const ruta = ri.path || ri.file_path;
    if (!escribe || !ruta) return;
    let propuesto = null;
    if (typeof ri.content === 'string') propuesto = ri.content;
    else if (typeof ri.file_text === 'string') propuesto = ri.file_text;
    if (propuesto == null && (typeof ri.old_string === 'string' || typeof ri.new_string === 'string')) {
      propuesto = { replace: [ri.old_string || '', ri.new_string || ''] };
    }
    if (propuesto == null) return;
    const box = document.createElement('div');
    box.className = 'perm-diff';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Cambios propuestos');
    box.textContent = 'Leyendo el archivo actual...';
    cardEl.insertBefore(box, cardEl.querySelector('.perm-btns'));
    try {
      const resp = await fetch('/file.json?path=' + encodeURIComponent(String(ruta)), { cache: 'no-store' });
      if (!resp.ok) {
        box.textContent = resp.status === 401 ? 'Iniciá sesión para ver el diff.' : 'No se puede leer este archivo para calcular el diff.';
        return;
      }
      const data = await resp.json();
      if (!data || data.exists === false) {
        if (propuesto && typeof propuesto === 'object') {
          box.textContent = 'El archivo no existe: no se puede calcular el diff del reemplazo.';
          return;
        }
        const nuevo = lineDiff('', propuesto);
        box.textContent = '';
        const head = document.createElement('div');
        head.className = 'perm-diff-head';
        head.textContent = 'Archivo nuevo (' + nuevo.resumen + ')';
        const pre = document.createElement('pre');
        pre.className = 'perm-diff-body';
        pre.textContent = (nuevo.lines || []).slice(0, 200).join('\n');
        box.append(head, pre);
        return;
      }
      const actual = String(data.text || '');
      let destino = propuesto;
      if (propuesto && typeof propuesto === 'object' && Array.isArray(propuesto.replace)) {
        const [viejo, nuevo] = propuesto.replace;
        if (viejo && !actual.includes(viejo)) {
          box.textContent = 'El texto a reemplazar no esta en el archivo actual: el diff no aplica tal cual.';
          return;
        }
        destino = viejo ? actual.replace(viejo, nuevo) : actual + nuevo;
      }
      const diff = lineDiff(actual, destino);
      box.textContent = '';
      const head = document.createElement('div');
      head.className = 'perm-diff-head';
      head.textContent = String(ruta) + ' \u00b7 ' + diff.resumen + (data.sha256 ? ' \u00b7 sha ' + String(data.sha256).slice(0, 8) : '');
      box.appendChild(head);
      if (!diff.lines) {
        const nota = document.createElement('div');
        nota.className = 'perm-diff-note';
        nota.textContent = diff.resumen;
        box.appendChild(nota);
        return;
      }
      const pre = document.createElement('pre');
      pre.className = 'perm-diff-body';
      pre.textContent = diff.lines.slice(0, 200).join('\n');
      box.appendChild(pre);
    } catch (e) {
      box.textContent = 'No pude leer el archivo para el diff: ' + String((e && e.message) || e);
    }
  }

  function showPermCard(m) {
    hideWelcome();
    noteRunActivity();
    const p = m.params || {};
    const tc = p.toolCall || {};
    const key = String(m.id);
    const previa = permCards.get(key);
    if (previa && previa.el.isConnected) return; // mismo pedido reenviado: una sola tarjeta
    const el = document.createElement('div');
    el.className = 'perm';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Aegis pide permiso para usar una herramienta');
    const cmd = tc.rawInput && (tc.rawInput.command || tc.rawInput.path) ? String(tc.rawInput.command || tc.rawInput.path) : '';
    const showCmd = cmd && !String(tc.title || '').includes(cmd.slice(0, 32));
    const etiqueta = String(tc.title || tc.kind || 'Herramienta');
    el.innerHTML =
      '<div class="perm-head"><svg class="perm-ico" width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="4.2" y="8.6" width="11.6" height="8" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M7 8.6V6.4a3 3 0 0 1 6 0v2.2" stroke="currentColor" stroke-width="1.5"/></svg>Aegis pide permiso para usar una herramienta</div>' +
      `<div class="perm-tool">${esc(etiqueta)}${showCmd ? ` — <code>${esc(cmd.slice(0, 220))}</code>` : ''}</div>` +
      '<div class="perm-btns"></div>' +
      `<div class="sr-only" role="status">Aegis pide permiso para ${esc(etiqueta)}. Elegí una opción.</div>`;
    // M4: revision de diff antes de aplicar. Si la herramienta escribe, se pide el estado actual
    // del archivo a /file.json y se muestra que queda distinto. El server manda el hash; si el
    // archivo cambio despues del diff, el bloque lo avisa en vez de mentir.
    void renderWriteDiff(el, tc);
    // El turno queda bloqueado hasta que el usuario responda: la barra lo dice.
    phaseSet('permission', etiqueta);

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
    const answer = (opt, label) => {
      const card = permCards.get(key);
      if (card && card.answered) return; // doble click / doble tap: un solo envio
      // Sin socket no se puede responder: no marcar como respondido algo que no salio.
      if (!rpc.ws || rpc.ws.readyState !== 1) {
        let ans = el.querySelector<HTMLElement>('.perm-answer');
        if (!ans) {
          ans = document.createElement('div');
          ans.className = 'perm-answer';
          ans.setAttribute('role', 'status');
          ans.setAttribute('aria-live', 'polite');
          el.appendChild(ans);
        }
        ans.textContent = 'Sin conexión: reintentá cuando vuelva.';
        return;
      }
      rpc.respond(m.id, { outcome: { outcome: 'selected', optionId: opt.optionId } });
      if (card) card.answered = true;
      permMarkAnswered(el, 'Respondido: ' + label);
      el.querySelectorAll<HTMLButtonElement>('.pb').forEach((b) => { b.disabled = true; });
    };
    for (const opt of candidates) {
      const [label, cls] = labels[opt.optionId] || [opt.name || opt.optionId, ''];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pb ' + cls;
      b.textContent = label;
      b.addEventListener('click', () => answer(opt, label));
      btns.appendChild(b);
    }
    permCards.set(key, { el, answered: false });
    msgWrap().appendChild(el);

    // Foco: si el usuario no esta escribiendo, va al primer boton (la tarjeta es lo unico
    // accionable y el turno esta bloqueado esperando). Si esta escribiendo, no se le roba.
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const escribiendo = !!input && document.activeElement === input && input.value.trim().length > 0;
    if (!escribiendo) {
      const first = btns.querySelector<HTMLButtonElement>('button');
      if (first) first.focus({ preventScroll: true });
    }

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
        const trig = Math.round(compactTrig(s).at);
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
    // Cache por sesion: el server manda el desglose al abrir la sesion y al cerrar cada
    // turno, no en cada notificacion. Sin cache, cambiar de chat (o recargar la pagina)
    // tiraba el desglose y el popover volvia a la version corta hasta el proximo turno.
    const cache = state.usageBySid || (state.usageBySid = {});
    if (state.usageSid) cache[state.usageSid] = state.usage || {};
    state.usageSid = sid;
    state.usage = (sid && cache[sid]) || {};
    renderUsage();
  }
  // ---------- popover de contexto: chico, anclado al readout, estilo Claude ----------
  let usagePop = null;
  const POP_PAD = 8, POP_GAP = 9;
  // Caja donde el panel tiene que entrar. Se usa `visualViewport` y no `innerWidth/Height`
  // porque en el telefono (teclado abierto, zoom) la parte visible es mas chica que el
  // viewport de layout: clampear contra el de layout dejaba el panel fuera de la pantalla.
  function popBox() {
    const vv = window.visualViewport;
    const vw = (vv && vv.width) || window.innerWidth;
    const vh = (vv && vv.height) || window.innerHeight;
    return {
      ox: (vv && vv.offsetLeft) || 0,
      oy: (vv && vv.offsetTop) || 0,
      vw, vh,
      // Techo de alto: el desglose completo (mas las filas por modelo) puede medir mas que
      // la pantalla; sin techo el panel no entra ni arriba ni abajo del readout.
      maxH: Math.max(140, vh - POP_PAD * 2)
    };
  }
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
    // Nace clampeado: si algo lo pinta antes del primer placeUsagePop, ya esta adentro.
    const b = popBox();
    w.style.maxHeight = b.maxH + 'px';
    w.style.overflowY = 'auto';
    w.style.overscrollBehavior = 'contain';
    w.style.left = b.ox + POP_PAD + 'px';
    w.style.top = b.oy + POP_PAD + 'px';
    document.addEventListener('pointerdown', (e) => {
      if (!usagePop || usagePop.hidden) return;
      const a = $('#meta-right');
      if (usagePop.contains(e.target) || (a && a.contains(e.target))) return;
      closeUsagePop();
    }, true);
    window.addEventListener('resize', placeUsagePop);
    window.addEventListener('scroll', placeUsagePop, true);
    // El teclado del telefono cambia el viewport visible sin disparar resize de window.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', placeUsagePop);
      window.visualViewport.addEventListener('scroll', placeUsagePop);
    }
    return w;
  }
  function placeUsagePop() {
    const w = usagePop;
    const a = $('#meta-right');
    if (!w || w.hidden || !a) return;
    const b = popBox();
    // El techo de alto se aplica antes de medir; si no cambio, no toca el layout.
    const mh = b.maxH + 'px';
    if (w.style.maxHeight !== mh) { w.style.maxHeight = mh; w.style.overflowY = 'auto'; }
    const r = a.getBoundingClientRect();
    const pw = Math.min(w.offsetWidth, Math.max(160, b.vw - POP_PAD * 2));
    const ph = Math.min(w.offsetHeight, b.maxH);
    // Prefiere abrirse arriba del readout; si no entra arriba ni abajo, se queda del lado
    // con mas lugar y el clamp de las coordenadas lo mete entero en la pantalla.
    const spaceAbove = r.top - POP_GAP - POP_PAD;
    const spaceBelow = b.oy + b.vh - r.bottom - POP_GAP - POP_PAD;
    const above = ph <= spaceAbove || spaceAbove >= spaceBelow;
    let top = above ? r.top - POP_GAP - ph : r.bottom + POP_GAP;
    let left = r.right - pw;
    // Clamp al viewport visible: cuatro bordes, nunca afuera.
    left = Math.max(b.ox + POP_PAD, Math.min(left, b.ox + b.vw - pw - POP_PAD));
    top = Math.max(b.oy + POP_PAD, Math.min(top, b.oy + b.vh - ph - POP_PAD));
    w.dataset.above = above ? '1' : '0';
    w.style.left = Math.round(left) + 'px';
    w.style.top = Math.round(top) + 'px';
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
    const mp: any = modelParts() || {};
    const pct = s.limit && s.used != null ? Math.min(100, (s.used / s.limit) * 100) : null;
    const ct = compactTrig(s);
    const trig = ct.at;
    const trigPct = ct.pct != null ? ct.pct : COMPACT_RATIO * 100;
    const col = pct == null ? 'var(--text-4)' : pct >= trigPct ? 'var(--danger)' : pct >= 50 ? 'var(--warn)' : 'var(--ok)';
    w.querySelector('.up-pct').textContent = pct == null ? '--' : Math.round(pct) + '%';
    w.querySelector('.up-pct').style.color = col;
    const vd = w.querySelector('.up-verdict');
    vd.textContent = pct == null ? 'sin medir todavia' : pct >= trigPct ? 'va a compactar' : pct >= 50 ? 'mas de la mitad' : 'holgado';
    const bar = w.querySelector('.up-meter i');
    bar.style.background = col === 'var(--text-4)' ? 'var(--text-4)' : 'linear-gradient(90deg, ' + col + ', ' + col + ')';
    w.querySelector('.up-meter em').style.left = Math.round(trigPct) + '%';
    w.querySelector('.up-sub').innerHTML = s.used == null ? 'todavia sin datos de uso' :
      '<b>' + niceTok(s.used) + '</b> de ' + niceTok(s.limit) + ' tok' + (trig ? '  ·  compacta a ' + niceTok(trig) + ' (' + Math.round(trigPct) + '%)' + (ct.estimated ? ' (estimado)' : '') : '');
    const mu = s.last || {};
    const rate = stepRate(mu);
    const cachePct = mu.cacheReadTokens != null && (mu.inputTokens || 0) + mu.cacheReadTokens > 0
      ? Math.round((mu.cacheReadTokens / Math.max(1, mu.inputTokens || 0)) * 100) + '%' : '--';
    w.querySelector('.up-rows').innerHTML =
      popRow('ultimo paso', 'entrada ' + niceTok(mu.inputTokens) + '  ·  salida ' + niceTok(mu.outputTokens) +
        (mu.elapsedMs != null ? '  ·  ' + (mu.elapsedMs / 1000).toFixed(1) + 's' : '') +
        (rate === null ? '' : '  ·  ' + (rate.kind === 'generation' ? 'generación ' : 'solicitud total ') + fmtTps(rate.value))) +
      popRow('cache', cachePct + (mu.timeToFirstTokenMs != null ? '  ·  1er token ' + (mu.timeToFirstTokenMs / 1000).toFixed(1) + 's' : '')) +
      popRow('sesion', 'entrada ' + niceTok(s.inTok) + '  ·  salida ' + niceTok(s.outTok)) +
      popRow('margen', s.limit && s.used != null && trig ? niceTok(Math.max(0, trig - s.used)) + ' tok antes de compactar' + (ct.estimated ? ' (estimado)' : '') : '--');
    // BITACORA DE COMPACTACIONES: cuando compacto, con cuanto contexto y quien lo pidio.
    // Antes solo existia el contador de llamadas internas; esto responde la pregunta que
    // importa ("¿esta sesion compacto bien, o se comio el historial?").
    const clog = Array.isArray(s.compactionLog) ? s.compactionLog : null;
    if (clog && clog.length) {
      const quien = (t) => t === 'tool' ? 'modelo' : t === 'manual' ? 'usuario' : 'umbral';
      const horas = clog.slice(-5).reverse().map((e) => {
        const hora = typeof e.at === 'string' ? e.at.slice(11, 16) : '--:--';
        const antesTok = niceTok(e.beforeTokens || 0);
        const despuesTok = niceTok(e.afterTokens || 0);
        const nota = e.note ? '  \u00b7  ' + esc(String(e.note).slice(0, 80)) : '';
        return popRow(quien(e.trigger) + ' ' + hora, antesTok + ' -> ' + despuesTok + nota);
      }).join('');
      w.querySelector('.up-rows').innerHTML +=
        '<div class="up-row" style="border-top:1px solid var(--line,#3a3a3a);margin-top:6px;padding-top:6px">'
        + '<span class="k">compactaciones</span><span class="v">' + clog.length + '</span></div>'
        + horas;
    }

    // DESGLOSE: vive en UN solo lugar, el drawer del medidor (context-meter.ts). Este popover lo
    // duplicaba con otro estilo y las dos vistas se desincronizaban. Aca queda el acceso.
    const verDesglose = document.createElement('button');
    verDesglose.type = 'button';
    verDesglose.className = 'up-link';
    verDesglose.textContent = 'Ver que ocupa el contexto';
    verDesglose.addEventListener('click', () => {
      closeMenus();
      const chip = document.getElementById('ctx-chip') || document.querySelector('.ctx-chip');
      if (chip instanceof HTMLElement) chip.click();
    });
    const pie = w.querySelector('.up-rows');
    if (pie) {
      const fila = document.createElement('div');
      fila.className = 'up-row';
      fila.style.cssText = 'border-top:1px solid var(--line,#3a3a3a);margin-top:6px;padding-top:6px';
      fila.append(verDesglose);
      pie.append(fila);
    }

    // Gasto real por modelo (una sesion puede cambiar de modelo a mitad de camino) y
    // compactacion interna, que se cobra pero no deja mensaje: filas aparte.
    (function () {
      const mid = '  ' + String.fromCharCode(183) + '  ';
      // Precios: si prices.json tiene numeros, se muestra el costo por modelo.
      const price = (m) => {
        const pr = (pricesCache && pricesCache[m.provider + '/' + m.model]) || null;
        // Sin entrada de precios para ese modelo la fila muestra solo tokens: nunca
        // puede romper el popover (antes tiraba TypeError y no abria).
        if (!pr) return '';
        const eff = pr.inputEffective != null ? pr.inputEffective : pr.input;
        if (eff == null) return '';
        const usd = (m.inputTokens / 1e6) * eff;
        return '  ' + String.fromCharCode(183) + '  USD ' + usd.toFixed(3);
      };
      let extra = '';
      if (Array.isArray(s.modelUsage) && s.modelUsage.length) {
        extra += s.modelUsage.map(function (m) {
          return popRow('  ' + m.model, m.calls + ' llam' + mid + 'entrada ' + niceTok(m.inputTokens) + mid + 'salida ' + niceTok(m.outputTokens) + price(m));
        }).join('');
      }
      if (s.compactionCalls) {
        extra += popRow('compactacion interna', s.compactionCalls + ' llam' + mid + 'entrada ' + niceTok(s.compactionInputTokens) + mid + 'salida ' + niceTok(s.compactionOutputTokens));
      }
      if (extra) w.querySelector('.up-rows').insertAdjacentHTML('beforeend', extra);
    })();
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

  if (!(window as any).__usagePopKeys) {
    (window as any).__usagePopKeys = true;
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
    el.onclick = () => {
      try { openUsagePop(); } catch (err) { report('error', 'popover de contexto: ' + (err && err.message ? err.message : err)); console.error(err); }
    };
  }
  // Precios por modelo (C:/aegis-web/prices.json, servido por el server web).
  let pricesCache = null;
  fetch('./prices.json').then((r) => r.json()).then((p) => { pricesCache = p || {}; }).catch(() => { pricesCache = {}; });
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
    if (u.autoCompactAt != null) s.autoCompactAt = u.autoCompactAt;
    if (Array.isArray(u.modelUsage) && u.modelUsage.length) s.modelUsage = u.modelUsage;
    if (u.compactionCalls != null) s.compactionCalls = u.compactionCalls;
    if (u.compactionInputTokens != null) s.compactionInputTokens = u.compactionInputTokens;
    if (u.compactionOutputTokens != null) s.compactionOutputTokens = u.compactionOutputTokens;
    if (u.autoCompactPct != null) s.autoCompactPct = u.autoCompactPct;
    // Bitacora de compactaciones (usage_update -> compactionLog, la manda el server desde el
    // estado de la sesion). Se guarda tal cual: el popover la muestra cuando se abre.
    if (Array.isArray(u.compactionLog)) s.compactionLog = u.compactionLog;
    renderUsage();
  }
  // message_usage (aegis-sdk-types): uso POR PASO, con cache y tiempos. El cliente lo ignoraba.
  function setMsgUsage(update) {
    const u = update?.usage;
    const dbg = state.usageDbg || (state.usageDbg = { setUsage: 0, setMsgUsage: 0, lastSet: null, lastMsg: null });
    dbg.setMsgUsage++; dbg.lastMsg = u;
    resetUsageForSession();
    const s = state.usage || (state.usage = {});
    if (u && !state.replaying && !state.hubReplay &&
        (!state.busy && !state.speed.note || (update?.messageId && state.speed.messages.has(update.messageId)))) s.last = u;
    speedExact(update);
    renderUsage();
  }

  // ---------- velocimetro de tokens/segundo ----------
  // Stream: sólo texto visible estimado; usage: generación medida o throughput de solicitud.
  // latest incluye el messageId para no llamar "actual" a un ritmo de otro paso.
  state.speed = state.speed || { ticks: [], el: null, avgEl: null, timer: 0, runOut: 0, runGen: 0, latest: null as null | { value: number; kind: 'generation' | 'request'; mid: string; order: number }, seen: new Set<string>(), messages: new Set<string>(), stepId: null, stepText: false, currentRate: false, runId: null, finished: false, note: null };
  // El estilo vive en app.css (.runbar-tps / .runbar-avg), no inline: asi el numero se ve
  // como metrica propia y no como parte de la frase del runbar.
  function speedSpan(id, after) {
    let el = $('#' + id);
    if (el) return el;
    const bar = $('#runbar');
    if (!bar) return null;
    el = document.createElement('span');
    el.id = id;
    el.hidden = true;
    if (after && after.parentNode) after.parentNode.insertBefore(el, after.nextSibling);
    else bar.appendChild(el);
    return el;
  }
  function speedEl() {
    const el = speedSpan('runbar-tps', $('#runbar-time'));
    if (el) el.className = 'runbar-tps';
    return el;
  }
  function speedAvgEl() {
    const el = speedSpan('runbar-avg', $('#runbar-tps') || speedEl());
    if (el) el.className = 'runbar-avg';
    return el;
  }
  function speedRateLabel(rate, previous = false) {
    return (previous ? 'última ' : '') + (rate.kind === 'generation' ? 'generación ' : 'solicitud ') + fmtTps(rate.value);
  }
  function speedLabel() {
    const s = state.speed;
    if (s.currentRate && s.latest?.mid === s.stepId) return speedRateLabel(s.latest);
    const now = performance.now();
    const recent = s.ticks.filter((t) => now - t.at <= 4000);
    if (recent.length >= 2) {
      const first = recent[0];
      const last = recent[recent.length - 1];
      const seconds = Math.max(0.4, (last.at - first.at) / 1000);
      const chars = last.chars - first.chars;
      if (chars > 0) return '~' + fmtTps(chars / 4 / seconds);
    }
    // Sin muestra del paso actual, conservar la última MEDICIÓN, identificada como anterior.
    // No confundir pensamiento/herramientas sin usage con velocidad de generación actual.
    return s.latest ? speedRateLabel(s.latest, true) : '— tok/s';
  }
  const compactRunBar = () => window.matchMedia('(max-width: 560px)').matches;
  function speedBadge(el, label) {
    if (!el) return;
    el.dataset.fullLabel = label;
    el.textContent = compactRunBar()
      ? label.replace(/^última generación /, 'últ. ').replace(/^última solicitud /, 'últ. sol. ').replace(/^generación /, '').replace(/^solicitud /, 'sol. ')
      : label;
    el.title = label.startsWith('~') ? 'Ritmo estimado de generación: ' + label
      : label.startsWith('última ') ? 'Última medición disponible (paso anterior): ' + label
      : label.startsWith('solicitud ') ? 'Throughput de solicitud completa (no generación): ' + label
      : label.startsWith('generación ') ? 'Ritmo medido de ' + label
      : 'Esperando tokens medidos o texto visible para estimar el ritmo';
    el.hidden = !label;
  }
  function speedPaint() {
    speedBadge(speedEl(), speedLabel());
    const avgEl = speedAvgEl();
    if (!avgEl) return;
    // El promedio incluye sólo generación medida y aparece al cerrar el turno.
    avgEl.textContent = '';
    avgEl.hidden = true;
  }
  function speedSummary() {
    const s = state.speed;
    return {
      last: s.latest?.value ?? null,
      kind: s.latest?.kind ?? null,
      avg: s.runOut > 0 && s.runGen > 0 ? s.runOut / (s.runGen / 1000) : null,
      out: s.runOut
    };
  }
  function speedStart() {
    const s = state.speed;
    s.ticks = []; s.latest = null; s.runOut = 0; s.runGen = 0;
    s.runId = state.runId || null; s.finished = false; s.seen.clear(); s.messages.clear(); s.stepId = null; s.stepText = false; s.currentRate = false; s.note = null;
    clearInterval(s.timer);
    s.timer = setInterval(speedPaint, 300);
    speedPaint();
  }
  function speedReset() {
    const s = state.speed;
    clearInterval(s.timer); s.timer = 0;
    s.ticks = []; s.latest = null; s.finished = true; s.runId = null; s.seen.clear(); s.messages.clear(); s.stepId = null; s.stepText = false; s.currentRate = false; s.note = null;
    s.runOut = 0; s.runGen = 0;
    speedBadge($('#runbar-tps'), '');
    const avg = $('#runbar-avg'); if (avg) { avg.textContent = ''; avg.hidden = true; }
  }
  function speedStep(messageId, nonText = false) {
    const s = state.speed;
    if (!messageId || !state.busy || state.replaying || state.hubReplay || s.finished) return;
    s.messages.add(messageId);
    if (s.stepId === messageId) {
      // Una fase de pensamiento/herramienta con el mismo id no hereda como actual
      // la métrica ya medida para una fase anterior del mismo mensaje.
      if (nonText && (s.stepText || s.currentRate)) { s.stepText = false; s.currentRate = false; s.ticks = []; speedPaint(); }
      else if (!nonText && (!s.stepText || s.currentRate)) { s.stepText = true; s.currentRate = false; s.ticks = []; speedPaint(); }
      return;
    }
    s.stepId = messageId;
    s.stepText = !nonText;
    s.currentRate = false;
    s.ticks = [];
    speedPaint(); // La medición previa sigue disponible, pero se etiqueta como "última".
  }
  function speedChunk(text, messageId?) {
    if (!text) return;
    const s = state.speed;
    if (!state.busy || state.replaying || state.hubReplay || s.finished) return;
    // Sin id no se puede distinguir un paso nuevo del anterior ni atribuir sus muestras.
    if (!messageId) { s.ticks = []; s.currentRate = false; s.stepId = null; speedPaint(); return; }
    speedStep(messageId);
    const prev = s.ticks.length ? s.ticks[s.ticks.length - 1].chars : 0;
    s.ticks.push({ at: performance.now(), chars: prev + text.length });
    if (s.ticks.length > 240) s.ticks.splice(0, s.ticks.length - 240);
  }
  function speedExact(update) {
    const s = state.speed;
    const mid = update?.messageId;
    // El load y el replay del hub incluyen message_usage antiguos. Nunca sumarlos
    // al run vivo, ni aceptar uso sin messageId (no se puede deduplicar).
    if (state.replaying || state.hubReplay || !mid || !update?.usage) return;
    if (s.finished) {
      // El terminal puede adelantarse al último usage: sólo admitir un mensaje
      // cuyo chunk ya pertenecía a ESTE run. No contaminar el siguiente turno.
      if (!s.note || !s.messages.has(mid)) return;
    } else if (!state.busy) return;
    if (s.runId && state.runId && s.runId !== state.runId) return;
    if (!s.messages.has(mid)) return; // prueba de pertenencia al run (no basta state.busy)
    if (s.seen.has(mid)) return;
    const rate = stepRate(update.usage);
    // Un elapsed demasiado breve no permite interpretar una tasa de solicitud estable.
    if (!rate || (rate.kind === 'request' && rate.durationMs < 1000)) return;
    s.seen.add(mid);
    const order = [...s.messages].indexOf(mid);
    // Usage tardío suma al promedio, pero nunca reemplaza una medición posterior.
    if (!s.latest || order >= s.latest.order) {
      s.latest = { value: rate.value, kind: rate.kind, mid, order };
      s.currentRate = mid === s.stepId;
    }
    if (rate.kind === 'generation') {
      s.runOut += update.usage.outputTokens;
      s.runGen += rate.durationMs;
    }
    if (s.finished) {
      const sum = speedSummary();
      s.note.innerHTML = speedNoteHtml(s.noteMs, sum);
      const bar = $('#runbar');
      if (bar && !bar.hidden && bar.classList.contains('done')) {
        const el = speedEl();
        speedBadge(el, sum.last === null ? '' : speedRateLabel({ value: sum.last, kind: sum.kind }));
        const avg = speedAvgEl();
        if (avg) { avg.textContent = sum.avg === null ? '' : 'prom generación ' + fmtTps(sum.avg) + ' · ' + sum.out + ' tok'; avg.hidden = sum.avg === null; }
      }
    } else speedPaint();
  }
  function speedFinish() {
    const s = state.speed;
    clearInterval(s.timer); s.timer = 0; s.finished = true;
    const sum = speedSummary();
    const el = speedEl();
    speedBadge(el, sum.last === null ? '' : speedRateLabel({ value: sum.last, kind: sum.kind }));
    const avgEl = speedAvgEl();
    if (avgEl) {
      avgEl.textContent = sum.avg === null ? '' : 'prom generación ' + fmtTps(sum.avg) + ' · ' + sum.out + ' tok';
      avgEl.hidden = sum.avg === null;
    }
    return sum;
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
    // (2026-10-15) Antes se removia SOLO el primero por id. Si dos cargas se cruzaban (recargar
    // muy rapido: el resume del boot y el re-watch del hub), cada una pintaba en su propio
    // contenedor y la conversacion se veia DOS veces (duplicado solo visual, el store intacto).
    // Se barren todos los contenedores y la pildora de cola.
    const box = $('#messages');
    if (box) box.querySelectorAll('.msg-inner, #tail-pill').forEach((n) => n.remove());
    else $('#msg-inner')?.remove();
    $('#status-pill')?.remove();
    hideWelcome();
  }

  function resetTransient() {
    state.msgs.clear();
    state.tools.clear();
    state.attachments = [];
    permCards.clear(); // las tarjetas de permiso viven en el DOM de la sesion anterior
    state.runId = null;
    state.adopted = false;
    liveRunRevision++;
    // (v6.4) El cursor del hub es por sesión: al cambiar de conversación arranca de cero.
    state.hubCursor = null;
    state.hubWatchSid = null;
    state.steers.clear();
    state.queue = [];
    state.goal = null;   // el objetivo es de la sesion: al cambiar de chat se recalcula con el replay
    state.grind = null;
    renderGoalBar();
    stopRunWatch();
    renderAttachments();
    finishStream();
    runBarHide();
  }

  // --- selector de carpeta al iniciar chat (2026-10-26) ---
  // Defaults por workspace guardados en el server (sobreviven a otro navegador/telefono).
  let wsDefaults: Record<string, any> = {};
  let wsDefaultsSaveTimer: any = null;

  function wsKey(path: string): string {
    return String(path).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  }

  function wsDefaultsFor(path: string): any {
    if (!path) return null;
    const k = wsKey(path);
    const hit = wsDefaults[k];
    return hit && typeof hit === 'object' ? (hit.defaults || null) : null;
  }

  async function loadWsDefaults(): Promise<void> {
    try {
      const res = await fetch('/ws/defaults', { credentials: 'same-origin' });
      const data = await res.json();
      if (data && typeof data === 'object') wsDefaults = data;
    } catch (e) {
      wsDefaults = {};
    }
  }

  function saveWsDefaults(path: string, defaults: any): void {
    if (!path) return;
    clearTimeout(wsDefaultsSaveTimer);
    wsDefaultsSaveTimer = setTimeout(() => {
      fetch('/ws/defaults', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: path, defaults }),
      }).catch(() => {});
    }, 800);
  }

  function workspaceRecents(limit: number): { cwd: string; when: string }[] {
    const seen = new Map<string, { cwd: string; when: string }>();
    const list: any[] = Array.isArray((state as any).sessions) ? (state as any).sessions : [];
    for (const s of list) {
      const cwd = s && s.cwd ? String(s.cwd) : '';
      if (!cwd) continue;
      const key = cwd.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase();
      const when = s.updatedAt || '';
      const prev = seen.get(key);
      if (!prev || when > prev.when) seen.set(key, { cwd, when });
    }
    return [...seen.values()].sort((a, b) => (a.when < b.when ? 1 : -1)).slice(0, limit);
  }

  function wsName(p: string): string {
    const parts = String(p).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p);
  }

  function openWorkspacePicker(): void {
    loadWsDefaults().then(() => { if (!$('#ws-picker')?.hidden) renderWsRows(); }).catch(() => {});
    renderWsRows();
  }

  function renderWsRows(): void {
    const pop = $('#ws-picker');
    const body = $('#ws-body');
    const input = $('#ws-input') as HTMLInputElement | null;
    if (!pop || !body) return;
    const rows: { cwd: string; label: string; meta: string }[] = [];
    const current = CFG.cwd || '';
    if (current) rows.push({ cwd: current, label: 'Carpeta por defecto', meta: current });
    for (const r of workspaceRecents(6)) {
      if (current && r.cwd.toLowerCase() === current.toLowerCase()) continue;
      rows.push({ cwd: r.cwd, label: wsName(r.cwd), meta: r.cwd });
    }
    for (const row of rows) {
      const d = wsDefaultsFor(row.cwd);
      if (d && (d.model || d.provider)) {
        row.meta = row.meta + '  ·  ' + [d.provider, d.model].filter(Boolean).join(' / ');
      }
    }
    body.innerHTML = rows.length
      ? rows.map((r) =>
          '<button class="ws-row" type="button" data-ws="' + esc(r.cwd) + '">' +
          '<span class="ws-name">' + esc(r.label) + '</span>' +
          '<span class="ws-path">' + esc(r.meta) + '</span></button>').join('')
      : '<p class="ws-empty">Todavía no hay carpetas usadas.</p>';
    if (input) input.value = localStorage.getItem('gweb.ws') || current || '';
    // acceso a navegar carpetas del server (allowlist AEGIS_WORKSPACE_ROOTS)
    body.innerHTML += '<button class="ws-row ws-browse" type="button" data-nav="">' +
      '<span class="ws-name">Elegir otra carpeta…</span>' +
      '<span class="ws-path">navegar</span></button>';
    (pop as HTMLElement).hidden = false;
    if (input) setTimeout(() => input.focus(), 0);
  }

  async function wsBrowse(path: string): Promise<void> {
    const body = $('#ws-body');
    if (!body) return;
    body.innerHTML = '<p class="ws-empty">Leyendo carpetas…</p>';
    let payload: any = null;
    try {
      const res = await fetch('/ws/list?path=' + encodeURIComponent(path || ''), { credentials: 'same-origin' });
      payload = await res.json();
    } catch (e) {
      body.innerHTML = '<p class="ws-empty">No se pudo leer la carpeta.</p>';
      return;
    }
    if (payload && payload.error) {
      body.innerHTML = '<p class="ws-empty">' + esc(String(payload.error)) + '</p>';
      return;
    }
    const rows: string[] = [];
    if (payload && payload.path) {
      rows.push('<button class="ws-row ws-use" type="button" data-ws="' + esc(payload.path) + '">' +
        '<span class="ws-name">Crear chat acá</span>' +
        '<span class="ws-path">' + esc(payload.path) + '</span></button>');
    }
    if (payload && payload.parent) {
      rows.push('<button class="ws-row" type="button" data-nav="' + esc(payload.parent) + '">' +
        '<span class="ws-name">..</span>' +
        '<span class="ws-path">' + esc(payload.parent) + '</span></button>');
    }
    const entries = (payload && Array.isArray(payload.entries)) ? payload.entries : [];
    for (const e of entries) {
      rows.push('<button class="ws-row" type="button" data-nav="' + esc(e.path) + '">' +
        '<span class="ws-name">' + esc(e.name) + '</span>' +
        '<span class="ws-path">' + esc(e.path) + '</span></button>');
    }
    if (!entries.length && payload && payload.path) {
      rows.push('<p class="ws-empty">Sin subcarpetas.</p>');
    }
    if (!payload || !payload.path) {
      rows.push('<p class="ws-empty">Elegí una raíz o escribí una ruta abajo.</p>');
    }
    body.innerHTML = rows.join('');
  }

  function closeWorkspacePicker(): void {
    const pop = $('#ws-picker');
    if (pop) (pop as HTMLElement).hidden = true;
  }

  function startSessionIn(cwd: string): void {
    closeWorkspacePicker();
    if (cwd) localStorage.setItem('gweb.ws', cwd);
    newSession(cwd);
  }

  async function newSession(workspace?: string) {
    const targetCwd = workspace || CFG.cwd || undefined;
    // defaults del workspace elegido (modelo/esfuerzo) antes de aplicar pendientes:
    // lo guardado en el server gana sobre el localStorage de este navegador
    state.pendingConfig = { ...leerPendientes(targetCwd), ...(wsDefaultsFor(targetCwd || '') || {}) };
    if (!rpc.ready) { systemNote('Sin conexión con el backend - reintentando.'); return; }
    clearTimeout(draftTimer);
    saveDraft(); detachRunView(); // si había un turno en curso, sigue corriendo en el server
    try {
      const res = await rpc.request('session/new', { cwd: targetCwd, mcpServers: [] });
      if (state.hubWatchSid) { const prev = state.hubWatchSid; state.hubWatchSid = null; await hubUnwatch(prev); }
      state.current = { id: res.sessionId, title: 'Nuevo chat', cwd: targetCwd || CFG.cwd, configOptions: res.configOptions || [], modes: res.modes || {} };
      // Si el usuario eligio modelo/esfuerzo antes de crear el chat, se aplica ahora.
      await aplicarPendientes(res.sessionId);
      resetTransient();
      clearMessages();
      showWelcome('new');
      loadDraft(); readLoad(); debateLoad(); enforceFixedModel();
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

  // Puente de deep-link: el replay se pinta despues de session/load y puede omitir
  // llamadas antiguas por replayTail. Nunca afirmar exito sin una carta real en DOM.
  async function openTool(sessionId: string, toolCallId: string): Promise<boolean> {
    if (!sessionId || !toolCallId) return false;
    const findCard = () => [...document.querySelectorAll<HTMLElement>('#msg-inner .tool[data-tool-call-id]')]
      .find((card) => card.dataset.toolCallId === toolCallId);
    const sameSession = state.current?.id === sessionId;
    const originalScroll = sameSession ? $('#messages')?.scrollTop : undefined;
    const entry = sameSession ? null : findSession(sessionId) ||
      (state.remote.sessions || []).find((s) => s.sessionId === sessionId);
    if (!sameSession && !entry) return false;
    if (!sameSession) {
      // El camino existente carga y reconstruye el replay; un load colgado no bloquea el bridge.
      const loaded = await Promise.race([
        openSession(entry).then(() => true, () => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000)),
      ]);
      if (!loaded || state.current?.id !== sessionId) return false;
    }
    const until = performance.now() + (sameSession ? 200 : 1800);
    let card = findCard();
    while (!card && performance.now() < until && state.current?.id === sessionId) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      card = findCard();
    }
    if (!card || state.current?.id !== sessionId) {
      if (sameSession && originalScroll !== undefined && state.current?.id === sessionId) $('#messages').scrollTop = originalScroll;
      return false;
    }
    releasePin?.(); // openSession ancla el fondo durante 1,4 s: no debe pisar el salto.
    card.scrollIntoView({ block: 'center', behavior: 'instant' });
    card.style.outline = '2px solid var(--accent, #7aa8ff)';
    card.style.outlineOffset = '3px';
    setTimeout(() => {
      if (card.style.outline) { card.style.removeProperty('outline'); card.style.removeProperty('outline-offset'); }
    }, 1800);
    return true;
  }

  async function openSession(entry) {
    const targetId = entry.sessionId || entry.id;
    clearTimeout(draftTimer);
    saveDraft();
    resetUsageForSession();
    // Con turno en curso se permite cambiar igual: el run sigue en el server y al
    // volver checkAdoptedRun() lo re-adopta (barra + Detener + refresco periódico).
    detachRunView();
    stopRunWatch();
    await renderSession(entry);
    if (state.current?.id !== targetId) return;
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
  let releasePin: (() => void) | null = null;
  function pinBottom(ms) {
    releasePin?.();
    const box = $('#messages');
    if (!box) return;
    state.pinUntil = performance.now() + (ms || 1200);
    const release = () => {
      if (releasePin === release) { state.pinUntil = 0; releasePin = null; }
      box.removeEventListener('wheel', release);
      box.removeEventListener('touchstart', release);
      box.removeEventListener('pointerdown', release);
    };
    releasePin = release;
    box.addEventListener('wheel', release, { passive: true });
    box.addEventListener('touchstart', release, { passive: true });
    box.addEventListener('pointerdown', release, { passive: true });
    let ultimaAltura = -1;
    const step = () => {
      if (!state.pinUntil || releasePin !== release) return;
      if (performance.now() > state.pinUntil) { release(); return; }
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
      markHiddenTail();
    }
  }

  // (2026-10-14) Abrir un chat de miles de mensajes costaba 13,6 MB de replay en 4162 frames
  // y ~2 s (medido en la sesion 20261013_51: 5750 mensajes). El server ya soporta replayTail
  // por meta: manda solo la cola, alineada a un mensaje de usuario, y el resto queda a un
  // click. replayMaxBlockBytes recorta bloques enormes (la UI ya corta la vista a 6000).
  const REPLAY_TAIL = 400;
  // 8 KB dejaba cortadas las respuestas largas (una de 18 KB se veia cortada al reabrir el chat,
  // y al pedir "explicame de nuevo" la nueva tambien). 64 KB cubre cualquier respuesta normal y
  // sigue evitando mandar bloques enormes; el recorte solo aparece en casos patologicos.
  const REPLAY_MAX_BLOCK = 65536;
  const replayMeta = (full) => ({
    // `full` (cargar todo): sin tope de bloque, para que el historial completo llegue entero.
    _meta: full
      ? { replayTail: 1000000000 }
      : { replayTail: REPLAY_TAIL, replayMaxBlockBytes: REPLAY_MAX_BLOCK },
  });

  function tailPill(show) {
    const box = $('#messages');
    if (!box) return;
    let el = box.querySelector('#tail-pill');
    if (!show) { if (el) el.remove(); return; }
    if (el) return;
    el = document.createElement('div');
    el.id = 'tail-pill';
    el.style.cssText = 'text-align:center;font-size:12px;opacity:.8;margin:6px 0 12px';
    el.innerHTML = 'Para abrir rapido se cargaron los ultimos ' + REPLAY_TAIL +
      ' mensajes. <button class="sk-btn" id="tail-full">Ver historial completo</button>';
    el.querySelector('#tail-full').onclick = (ev) => {
      ev.stopPropagation();
      el.remove();
      renderSession(state.current, { quiet: true, full: true });
    };
    box.insertBefore(el, box.firstChild);
  }

  // (2026-10-15) Sólo la carga MAS NUEVA pinta. Con recarga rapida se solapan el resume del
  // boot con el re-watch del hub / el camino de gap: dos renderSession concurrentes pintaban la
  // misma conversacion dos veces. La vieja ahora se retira en vez de pisar el DOM.
  let renderGen = 0;
  async function renderSession(entry, opts?) {
    const gen = ++renderGen;
    const id = entry.sessionId || entry.id;
    if (state.current?.id !== id) {
      clearTimeout(draftTimer);
      saveDraft();
    }
    if (state.current?.id !== id && state.hubWatchSid) { const prev = state.hubWatchSid; state.hubWatchSid = null; hubUnwatch(prev); }
    state.current = { id, title: entry.title || 'Sesión', cwd: entry.cwd, configOptions: entry.configOptions || [], modes: entry.modes || {} };
    resetTransient();
    clearMessages();
    updateTitle(); markActive(id); closeDrawer(); loadDraft(); readLoad(); debateLoad(); enforceFixedModel();
    localStorage.setItem('gweb.last', id);
    // Las tarjetas de permiso que llegaron mientras se miraba otro chat se pintan recien cuando
    // el replay de esta sesion ya esta puesto.
    setTimeout(() => { if (state.current?.id === id) flushPermPendientes(id); }, 800);
    setTimeout(() => { if (state.current?.id === id) aplicarAvisoPendientes(id); }, 900);
    if (!opts || !opts.quiet) setPill('Cargando conversación.');
    if (!SOFT.on) {
      state.replayBuf = []; // (v6.6) se pinta en dos fases al terminar el load
      const replayBuffer = state.replayBuf;
      state.hideTail = false; // el replay arranca limpio: se vuelve a marcar al cruzar el turno rebobinado
      // Red de seguridad: si la fase doble no llegara a correr (una excepcion en el
      // medio), el buffer se vuelca crudo en vez de dejar la conversacion congelada.
      setTimeout(() => {
        if (gen !== renderGen || state.current?.id !== id || state.replayBuf !== replayBuffer) return;
        const sobrante = state.replayBuf;
        state.replayBuf = null;
        for (const p of sobrante) { try { applyUpdate(p); } catch (e) {} }
        flushRender();
      }, 8000);
    }
    state.replaying = true;
    try {
      const res = await rpc.request('session/load', { sessionId: id, cwd: state.current.cwd || CFG.cwd, mcpServers: [], ...replayMeta(!!(opts && opts.full)) });
      if (gen !== renderGen || state.current?.id !== id) return;
      if (res && Array.isArray(res.configOptions)) state.current.configOptions = res.configOptions;
      if (res && res.modes) state.current.modes = res.modes;
      renderChips();
    } catch (e) {
      if (gen === renderGen && state.current?.id === id) systemNote('No se pudo cargar la sesión: ' + e.message);
    }
    if (gen !== renderGen || state.current?.id !== id) return; // otra carga mas nueva ya tomo el DOM: no pintar esta
    state.replaying = false;
    if (state.replayBuf) await paintReplayTwoPhase(); else await drainRender(); // el replay se pinta por tramos: esperar al último antes de cerrar y scrollear
    if (gen !== renderGen || state.current?.id !== id) return;
    clearStreaming(); // el replay nunca debe dejar un cursor de streaming colgado
    flushRender(); // pinta lo que haya quedado pendiente del replay
    setPill(null);
    if (state.msgs.size) hideWelcome();
    else showWelcome('empty', state.current.title);
    updateMetaHints();
    // Si llegaron tantos mensajes como pedimos de cola, es probable que haya mas arriba.
    tailPill(!(opts && opts.full) && state.msgs.size >= REPLAY_TAIL);
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

  // ---- fases del turno: qué está haciendo Aegis AHORA -------------------------
  // Un solo lugar decide la fase; los handlers solo avisan. La barra muestra icono,
  // nombre de la fase y segundos transcurridos en ELLA: un paso de tres minutos deja de
  // parecer colgado, y se ve el cambio de "pensando" a "herramienta" a "escribiendo"
  // sin leer el detalle. Los nombres son los del protocolo traducidos, no adornos.
  const PHASE_LABEL: Record<string, string> = {
    thinking: 'Pensando',
    writing: 'Escribiendo',
    tool: 'Herramienta',
    permission: 'Esperando tu permiso',
    compacting: 'Compactando contexto',
    waiting: 'Esperando al proveedor',
    cancel: 'Deteniendo',
    done: 'Listo',
  };
  const PHASE_ICON: Record<string, string> = {
    thinking: 'spark', writing: 'doc', tool: 'shell', permission: 'lock',
    compacting: 'compact', waiting: 'clock', cancel: 'clock', done: 'check',
  };
  const PHASE = { name: '', since: 0 };
  function phasePaint() {
    const el = $('#runbar-phase');
    if (!el || el.hidden || !PHASE.name) return;
    const since = el.querySelector('.rp-since');
    if (!since) return;
    const s = Math.max(0, (performance.now() - PHASE.since) / 1000);
    // menos de 3 s no se escribe: un contador que parpadea distrae mas de lo que informa
    since.textContent = s >= 3 ? (s < 60 ? Math.round(s) + ' s' : Math.floor(s / 60) + ' min') : '';
    const det = el.dataset.detail || '';
    el.title = (PHASE_LABEL[PHASE.name] || PHASE.name) + (det ? ' · ' + det : '');
  }
  function phaseSet(name: string, detail?: string) {
    const el = $('#runbar-phase');
    const bar = $('#runbar');
    const next = name || '';
    if (bar) bar.dataset.phase = next;
    if (!next) {
      PHASE.name = '';
      if (el) { el.hidden = true; el.innerHTML = ''; }
      return;
    }
    if (PHASE.name !== next) PHASE.since = performance.now();
    PHASE.name = next;
    if (!el) return;
    el.dataset.detail = detail || '';
    el.hidden = false;
    el.innerHTML = uiIcon(PHASE_ICON[next] || 'dot', { size: 12 })
      + '<span class="rp-name">' + esc(PHASE_LABEL[next] || next) + '</span>'
      + '<span class="rp-since"></span>';
    phasePaint();
  }
  // Mantener una etiqueta corta en teléfonos, sin perder el diagnóstico completo.
  function setRunBarText(full) {
    const el = $('#runbar-text');
    const bar = $('#runbar');
    if (!el || !bar) return;
    bar.dataset.fullStatus = full;
    renderRunBarText();
  }
  function renderRunBarText() {
    const bar = $('#runbar'), el = $('#runbar-text');
    if (!bar || !el) return;
    const full = bar.dataset.fullStatus || '';
    el.title = full;
    el.textContent = compactRunBar()
      ? (bar.classList.contains('done') ? 'Terminado' : bar.classList.contains('cancelling') ? 'Deteniendo…'
        : full.startsWith('El corte no se confirmó') ? 'Sin confirmar' : 'Trabaja')
      : full;
  }
  function paintQueuedRunBar() {
    const bar = $('#runbar');
    if (!bar) return;
    let badge = $('#runbar-queued');
    const count = state.queue.length + state.steers.size;
    if (!badge && count) {
      badge = document.createElement('span');
      badge.id = 'runbar-queued'; badge.className = 'runbar-queued';
      $('#runbar-text').after(badge);
    }
    if (badge) {
      badge.hidden = !state.busy || !count || bar.hidden;
      badge.textContent = compactRunBar() ? 'pendiente' : count === 1 ? '1 pendiente' : count + ' pendientes';
      badge.title = count === 1 ? '1 indicación pendiente del agente' : count + ' indicaciones pendientes del agente';
    }
  }
  window.addEventListener('resize', () => {
    renderRunBarText();
    paintQueuedRunBar();
    const el = $('#runbar-tps');
    if (el) speedBadge(el, el.dataset.fullLabel || '');
  });
  const paintRunBar = () => {
    paintQueuedRunBar();
    const t = $('#runbar-time');
    if (t && runStart) t.textContent = fmtElapsed(performance.now() - runStart);
    phasePaint();
  };
  function runBarShow(text) {
    const bar = $('#runbar');
    if (!bar) return;
    clearTimeout(runDoneTimer);
    bar.hidden = false;
    bar.classList.remove('done', 'cancelling');
    setRunBarText(text || 'Aegis está trabajando…');
    paintQueuedRunBar();
    if (!PHASE.name) phaseSet('thinking');
    $('#btn-stop').disabled = false;
    if (!runStart) runStart = performance.now();
    paintRunBar();
    speedStart();
    $('#messages')?.setAttribute('aria-busy', 'true');
    clearInterval(runTick);
    runTick = setInterval(paintRunBar, 250);
  }
  function runBarHide() {
    const bar = $('#runbar');
    clearInterval(runTick); runTick = 0;
    clearTimeout(runDoneTimer); runDoneTimer = 0;
    clearTimeout(cancelTimer); cancelTimer = 0;
    runStart = 0;
    speedReset();
    $('#messages')?.setAttribute('aria-busy', 'false');
    if (bar) { bar.hidden = true; bar.classList.remove('done', 'cancelling'); }
    paintQueuedRunBar();
    phaseSet('');
    $('#btn-stop').disabled = false;
  }
  function runBarDone(text, ms) {
    // El turno termino: cualquier permiso sin responder queda sin efecto (el hub ya cerro el
    // pedido). Sin esto quedaban botones vivos que no hacian nada.
    if (permCards.size) expirePermCards('el turno terminó sin respuesta.');
    const bar = $('#runbar');
    clearInterval(runTick); runTick = 0;
    clearTimeout(cancelTimer); cancelTimer = 0;
    if (!bar) return;
    bar.hidden = false;
    bar.classList.remove('cancelling');
    bar.classList.add('done');
    setRunBarText(text);
    paintQueuedRunBar();
    phaseSet('done');
    $('#runbar-time').textContent = fmtElapsed(ms);
    speedFinish();
    $('#messages')?.setAttribute('aria-busy', 'false');
    $('#btn-stop').disabled = false;
    clearTimeout(runDoneTimer);
    runDoneTimer = setTimeout(() => { bar.hidden = true; bar.classList.remove('done'); updateMetaHints(); }, 6000);
  }
  // Marca del fin del turno en la conversación: queda donde terminó el streaming,
  // así se ve aunque la barra de arriba ya se haya ido.
  function speedNoteHtml(ms, sum) {
    const parts = ['fin del turno · ' + fmtElapsed(ms)];
    if (sum.last !== null) parts.push(speedRateLabel({ value: sum.last, kind: sum.kind }));
    if (sum.avg !== null) parts.push('prom generación ' + fmtTps(sum.avg) + ' · ' + sum.out + ' tok');
    return esc(parts[0]) + parts.slice(1).map((p) => ' · <span class="te-tps">' + esc(p) + '</span>').join('');
  }
  function turnEndNote(ms) {
    const el = document.createElement('div');
    el.className = 'turn-end';
    // El último usage puede llegar DESPUÉS del marcador de fin: conservar su nodo
    // hasta que arranque otro turno para corregir el resumen sin inventar un ritmo.
    state.speed.note = el; state.speed.noteMs = ms;
    el.innerHTML = speedNoteHtml(ms, speedSummary());
    msgWrap().appendChild(el);
    // "Regenerar" vive en el menu de acciones de la ultima respuesta: se arma al abrir
    // (accionesDeMensaje), asi que no hay que mover ningun nodo de turno en turno.
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
      setRunBarText('Deteniendo…');
      $('#btn-stop').disabled = true;
    }
    systemNote('Cancelando…');
    // Red de seguridad: si el server no cierra el run, no dejamos la barra mintiendo
    // en "Deteniendo…" para siempre — se puede volver a intentar.
    clearTimeout(cancelTimer);
    cancelTimer = setTimeout(() => {
      const b = $('#runbar');
      if (!state.busy || !b || b.hidden) return;
      b.classList.remove('cancelling');
      setRunBarText('El corte no se confirmó — probá Detener otra vez');
      $('#btn-stop').disabled = false;
    }, 12000);
  }

  // ---------- enviar / steering ----------
  // Watchdog de turno huérfano: reconcilia busy con el run real, también en
  // otra pestaña o cuando la notificación terminal se perdió durante una reconexión.
  let orphanTimer = 0;
  // Con hub se consulta session/info (nunca steer) cada 5 s mientras haya un turno;
  // si falta el evento terminal, se reconcilia sin recargar la página.
  const orphanTickMs = () => (state.hubWatch === true ? 5000 : 15000);
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
    HUB.orphanMissAt = 0;
    stopRunWatch();
    stopOrphanWatch();
    runBarHide();
    $('#btn-send').hidden = false;
    $('#btn-stop').hidden = true;
    $('#btn-attach').classList.remove('busy');
    updateMetaHints();
    return true;
  }

  function setBusy(b, note, startAt?) {
    const was = state.busy;
    state.busy = b;
    if (!b) readFlush();   // fin del turno: leer lo que haya quedado sin punto final
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
    if (state.busy || !$('#runbar')?.hidden) {
      l.textContent = ''; // el estado y la velocidad usan esta misma franja
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

  // Un swap del serve o una caida de red mataba el prompt en silencio (41 casos en el log del
  // 14/10). Si el error es de conexion se reintenta el mismo texto, pero SOLO con evidencia de que
  // el intento anterior no llego: reenviar a ciegas era lo que creaba el mensaje y el turno duplicados.
  function sessionMsgCount(sid) {
    // session/list devuelve _meta.messageCount por sesion (verificado contra el serve vivo: 493).
    const s = (state.sessions || []).find(function (x) { return x && x.sessionId === sid; });
    const n = s && s._meta && s._meta.messageCount;
    return (typeof n === 'number') ? n : null;
  }

  async function promptConRetry(text, atts, sidArg) {
    // (2026-10-15) sid explicito: antes usaba state.current.id en CADA intento, asi que si te ibas
    // a otro chat mientras esperaba el reintento, el prompt podia caer en la sesion equivocada.
    const sid = sidArg || (state.current && state.current.id);
    const antes = sessionMsgCount(sid); // linea base: si el mensaje se persiste, el conteo sube
    // Idempotencia: el mismo promptId en los 3 intentos. Si el primero llego y se corto la
    // respuesta, el server devuelve el resultado de esa corrida en vez de ejecutar el turno
    // otra vez (o espera a que termine). Un mensaje nuevo = un promptId nuevo.
    const promptId = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    for (let intento = 1; intento <= 3; intento++) {
      try {
        return await rpc.request('session/prompt', { sessionId: sid, prompt: promptBlocks(text, atts), _meta: { promptId } });
      } catch (e) {
        const msg = String((e && e.message) || e);
        const transitorio = /conexi|closed|ECONNRESET|socket|network/i.test(msg);
        if (!transitorio || intento === 3) throw e;
        systemNote('Se corto la conexion; verificando si tu mensaje llego...');
        await new Promise(function (r) { setTimeout(r, intento * 3000); });
        for (let i = 0; i < 20 && !rpc.ready; i++) await new Promise(function (r) { setTimeout(r, 1000); });
        // Dos señales independientes de que el intento anterior SI llego:
        //  1) la sesion figura corriendo (el turno arranco);
        //  2) subio _meta.messageCount (el mensaje quedo persistido) — cubre el caso en que el turno
        //     ya habia terminado cuando llego el reintento, que la señal 1 sola no ve.
        // Si el conteo no subio, el mensaje NO llego y reintentar es seguro (y necesario).
        let verificado = false;
        try {
          // refreshSessions se traga el error de conexion (solo reporta), asi que por si solo no
          // sirve como señal de "no pude verificar": se chequea la conexion de forma directa.
          if (!rpc.ready) throw new Error('sin conexion');
          await refreshSessions();
          const despues = sessionMsgCount(sid);
          const corriendo = !!(sid && state.runningIds && state.runningIds.has(sid));
          const crecio = (antes != null && despues != null && despues > antes);
          if (corriendo || crecio) {
            report('adopt', 'el prompt ya habia llegado (' + (corriendo ? 'turno corriendo' : 'messageCount ' + antes + '->' + despues) + '): no se reenvia');
            systemNote('La conexion volvio: tu mensaje ya estaba enviado.');
            try { await resyncAdoptedRun(); } catch (e2) {}
            return {};
          }
          verificado = (antes != null && despues != null);
        } catch (e3) { /* la conexion no volvio: no se pudo verificar */ }
        if (!verificado) {
          // Sin poder comprobar, antes se reenviaba a ciegas y eso duplicaba el turno. Mejor
          // devolverle el texto al usuario que mandarlo dos veces.
          const errNC = new Error('No se pudo confirmar si tu mensaje llego.') as Error & { aegisNoConfirmado?: boolean };
          errNC.aegisNoConfirmado = true;
          throw errNC;
        }
      }
    }
  }
  // --- Dictado por voz + modo manos libres (2026-10-22) -----------------------------------
  // Graba con MediaRecorder y manda el audio a _aegis/unstable/dictation/transcribe.
  // Sobre la version 2026-10-15:
  //   * VAD: corta solo tras ~900 ms de silencio despues de hablar (no hay que tocar nada).
  //   * Cadena de proveedores: groq (whisper-large-v3-turbo) y, si falla, el modelo activo.
  //   * En manos libres (debate + lectura) el texto se envia solo y, cuando termina la voz del
  //     bot, el microfono se vuelve a abrir: la conversacion cierra el circulo sola.
  // Un solo motor: whisper local (el mismo camino que usa piper para leer). Antes habia una
  // cadena groq -> model que fallaba siempre en esta maquina: groq sin GROQ_API_KEY y 'model'
  // mandando el audio al modelo de chat, que no transcribe.
  var VOICE_PROVIDERS = ['local'];
  var VOICE_MIN_MS = 450, VOICE_MAX_MS = 90000, VOICE_SILENCE_MS = 900, VOICE_RMS = 0.012;
  var VOICE_IDLE_MS = 8000;   // auto-escucha sin voz: descarta y vuelve a abrir (no transcribe silencio)
  var MIC: any = { rec: null, chunks: [], stream: null, ctx: null, analyser: null, buf: null, timer: 0, auto: false, granted: false, startedAt: 0, spoke: false, quietSince: 0, barge: false, bargeHits: 0 };

  function micSecure() { return !!window.isSecureContext; }

  function micInsert(txt) {
    const t = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!t) return;
    const s = t.selectionStart == null ? t.value.length : t.selectionStart;
    const e = t.selectionEnd == null ? t.value.length : t.selectionEnd;
    const pre = t.value.slice(0, s), post = t.value.slice(e);
    const sep = (pre && !/\s$/.test(pre)) ? ' ' : '';
    t.value = pre + sep + txt + post;
    const pos = (pre + sep + txt).length;
    try { t.setSelectionRange(pos, pos); } catch (err) {}
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.focus();
  }

  function micSetState(on) {
    const btn = document.getElementById('btn-mic');
    if (!btn) return;
    btn.classList.toggle('rec', !!on);
    btn.classList.toggle('barge', !!(on && MIC.barge));
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Grabando… tocá para cortar y transcribir' : 'Dictar por voz (corta solo cuando te quedás callado)';
  }

  function micStop(discard?) {
    if (!MIC.rec) return;
    if (discard) MIC.discard = true;
    try { MIC.rec.stop(); } catch (e) {}
  }

  function micCleanup() {
    try { if (MIC.stream) MIC.stream.getTracks().forEach(function (x) { x.stop(); }); } catch (e) {}
    try { if (MIC.ctx && MIC.ctx.close) MIC.ctx.close(); } catch (e) {}
    if (MIC.timer) { clearInterval(MIC.timer); MIC.timer = 0; }
    MIC.stream = null; MIC.ctx = null; MIC.analyser = null; MIC.buf = null;
  }

  // VAD por energia: marca cuando hubo voz y pide el corte tras VOICE_SILENCE_MS de silencio.
  function micWatch(stream) {
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      MIC.ctx = ctx; MIC.analyser = an; MIC.buf = new Float32Array(an.fftSize);
      MIC.timer = setInterval(function () {
        if (!MIC.analyser || !MIC.buf) return;
        MIC.analyser.getFloatTimeDomainData(MIC.buf);
        let sum = 0;
        for (let i = 0; i < MIC.buf.length; i++) sum += MIC.buf[i] * MIC.buf[i];
        const rms = Math.sqrt(sum / MIC.buf.length);
        const now = Date.now();
        if (now - MIC.startedAt > VOICE_MAX_MS) { micStop(); return; }
        // Barge-in: mientras el bot habla el micro tiene que quedar abierto aunque no haya voz
        // (si se cierra por inactividad, un turno largo de voz ya no se puede interrumpir).
        if (MIC.auto && !MIC.spoke && now - MIC.startedAt > VOICE_IDLE_MS && !(MIC.barge && AUD.playing)) {
          micStop(true); return;
        }
        // Con el bot hablando (barge-in) el umbral sube: el eco del parlante no debe cortar.
        const umbral = (MIC.barge && AUD.playing) ? 0.03 : VOICE_RMS;
        if (rms >= umbral) {
          MIC.spoke = true; MIC.quietSince = 0;
          if (MIC.barge && AUD.playing) {
            MIC.bargeHits = (MIC.bargeHits || 0) + 1;
            if (MIC.bargeHits >= 3 && AUD.playing) {
              report('barge', 'interrupcion: rms=' + rms.toFixed(3) + ' hits=' + MIC.bargeHits);
              audStop();   // el usuario interrumpio: se corta la voz
            }
          }
          return;
        }
        MIC.bargeHits = 0;
        if (!MIC.spoke) return;
        if (!MIC.quietSince) { MIC.quietSince = now; return; }
        if (now - MIC.quietSince >= VOICE_SILENCE_MS) micStop();
      }, 100);
    } catch (e) { report('mic', 'VAD no disponible: ' + String((e && (e as any).message) || e)); }
  }

  function micTranscribe(blob, idx?, auto?) {
    const i = idx || 0;
    const provider = VOICE_PROVIDERS[i];
    const btn = document.getElementById('btn-mic');
    if (!provider) {
      if (btn) btn.classList.remove('busy');
      systemNote('No pude transcribir: no hay motor de dictado local disponible.');
      handsFreeMaybe(600);
      return;
    }
    if (btn) btn.classList.add('busy');
    systemNote('Transcribiendo ' + Math.round(blob.size / 1024) + ' KB con ' + provider + '…');
    // El motor local decodifica con symphonia, que no tiene decoder de Opus: el webm/opus que
    // produce MediaRecorder se convierte a WAV 16 kHz mono en el navegador (src/app/audio-wav.ts).
    // Sin esto el turno moria en "Internal error" (Failed to create audio decoder) y el dictado
    // no funcionaba en Chrome/Android, que es justo donde esta el microfono.
    blobToWav16k(blob).then(function (wav) {
      const b64 = bytesToBase64(wav);
      return rpc.request('_aegis/unstable/dictation/transcribe', { audio: b64, mimeType: 'audio/wav', provider: provider });
    }).then(function (r) {
      if (btn) btn.classList.remove('busy');
      const txt = ((r && r.text) || '').trim();
      if (!txt) { systemNote('La transcripción vino vacía (' + provider + ').'); handsFreeMaybe(600); return; }
      micDeliver(txt, auto);
    }).catch(function (e) {
      const msg = String((e && e.message) || e).slice(0, 240);
      report('dictado', provider + ' falló: ' + msg);
      if (btn) btn.classList.remove('busy');
      systemNote('Falló la transcripción: ' + msg);
      handsFreeMaybe(1500);
    });
  }

  // En manos libres el dictado se ENVIA; en manual se inserta en el cursor.
  function micDeliver(txt, auto?) {
    systemNote('Dictado: ' + txt.slice(0, 90));
    if (auto && !state.busy) { sendText(txt); return; }
    micInsert(txt);
  }

  function micStart(opts?) {
    if (MIC.rec) { micStop(); return; }   // segundo toque: cortar y transcribir
    if (!micSecure()) { systemNote('El micrófono necesita HTTPS (o localhost). Por esta dirección el navegador no lo permite: usá https://' + location.hostname + ':3789 (la misma UI con TLS) o la URL del túnel.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) { systemNote('Este navegador no soporta grabación de audio.'); return; }
    MIC.auto = !!(opts && opts.auto);
    // Cualquier escucha que arranque mientras el bot habla es barge-in (aunque venga del ciclo
    // de manos libres, que reabre el micro sin pasar por audNext).
    MIC.barge = !!(opts && opts.barge) || !!(AUD.playing && READ_ON);
    MIC.bargeHits = 0;
    MIC.discard = false;
    MIC.spoke = false; MIC.quietSince = 0;
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (st) {
        MIC.granted = true;
        MIC.stream = st;
        const mt = (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) ? 'audio/webm;codecs=opus' : '';
        MIC.chunks = [];
        const rec = mt ? new MediaRecorder(st, { mimeType: mt }) : new MediaRecorder(st);
        MIC.rec = rec;
        MIC.startedAt = Date.now();
        rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) MIC.chunks.push(ev.data); };
        rec.onstop = function () {
          const ms = Date.now() - MIC.startedAt;
          const chunks = MIC.chunks; MIC.chunks = [];
          const discard = MIC.discard;
          const auto = MIC.auto;
          MIC.discard = false;
          MIC.auto = false;
          MIC.rec = null;
          micCleanup();
          micSetState(false);
          if (discard) { handsFreeMaybe(150); return; }   // sin voz: no hay nada que mandar, vuelve a escuchar
          const blob = new Blob(chunks, { type: ((rec.mimeType || 'audio/webm').split(';')[0]) });
          if (!blob.size) { systemNote('No se grabó audio.'); return; }
          if (ms < VOICE_MIN_MS) { systemNote('Grabación muy corta (' + ms + ' ms): la descarto.'); return; }
          micTranscribe(blob, 0, auto);
        };
        rec.start();
        micSetState(true);
        micWatch(st);
        if (!MIC.auto) systemNote('Grabando… tocá el micrófono para cortar, o quedate callado ~1 s y corta solo.');
      })
      .catch(function (e) {
        MIC.rec = null; MIC.auto = false; micSetState(false);
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
          MIC.denied = true;   // no reintentar solo: el permiso lo tiene que dar el usuario
          report('barge', 'permiso de microfono rechazado: ' + e.name);
          systemNote('El navegador bloqueó el micrófono: sin permiso no puedo escucharte para interrumpir.');
          return;
        }
        systemNote('No pude abrir el micrófono: ' + String((e && e.message) || e).slice(0, 140));
      });
  }

  // --- Modo debate: conversar antes de trabajar --------------------------------------------
  // Encendido: la sesión pasa a `chat` (el server rechaza TODA herramienta) y cada mensaje
  // lleva una instruccion corta para discutir el plan. Cuando decis "dale" (o una de las
  // frases de VOICE_SETTLE) vuelve a `auto` y ese mensaje ya se ejecuta.
  var DEBATE: any = DEBATE || { on: false, prev: 'auto', turns: 0, prevEffort: '' };
  // Manos libres: se prende con Debate y sigue activo despues de decir "dale" (para escuchar
  // el trabajo y poder seguir hablando). Se apaga apagando Debate.
  var HF: any = { on: false };
  // El "dale" puede venir en cualquier parte de la frase (hablando: "bueno, dale, arranquemos").
  var VOICE_SETTLE = /(^|[\s,.;:¡!¿?])(dale|adelante|ejecut[aá]|hacelo|hacélo|metele|arranc[aá]|arranquemos|vamos)(?=$|[\s,.;:!?])/i;
  // Regla del operador: con open_design y opencode_go el modelo es SIEMPRE deepseek-v4.1-flash.
  // Cualquier otro modelo se rechaza en el chip y se corrige al abrir el chat.
  var FIXED_MODELS: Record<string, string> = { open_design: 'deepseek-v4.1-flash', opencode_go: 'deepseek-v4.1-flash' };
  function providerNow() {
    const opts = (state.current && state.current.configOptions) || [];
    const opt = opts.find((o) => o && o.id === 'provider');
    return opt ? String(opt.currentValue || '') : '';
  }
  function modelNow() {
    const opts = (state.current && state.current.configOptions) || [];
    const opt = opts.find((o) => o && o.id === 'model');
    return opt ? String(opt.currentValue || '') : '';
  }
  async function enforceFixedModel() {
    const prov = providerNow();
    const want = FIXED_MODELS[prov];
    if (!want || modelNow() === want) return false;
    try {
      await setConfig('model', want);
      systemNote('Modelo fijado a ' + want + ' con ' + prov + '.');
      return true;
    } catch (e) {
      report('modelo', 'no pude fijar ' + want + ': ' + String((e && e.message) || e).slice(0, 120));
      return false;
    }
  }
  var DEBATE_PREAMBLE = '[Debate: podes LEER (read_file, grep, tree, web, skills) pero NO modificar nada: shell, edit y write estan bloqueados por el server. Discutí el plan, marcá riesgos y hacé preguntas. Respondé corto: 2 a 4 frases. Cuando ya este claro que hay que hacer, cerra el debate vos: escribi una linea "— plan final —" y debajo el plan concreto, en imperativo y con el orden de los pasos. Si es solo charla, cerra con "— fin del debate —".]';

  function debateKeyFor(id) { return 'aegis.debate.' + (id || 'nuevo'); }
  function debateLoad() {
    if (!DEBATE) DEBATE = { on: false, prev: 'auto' };
    try { DEBATE.on = localStorage.getItem(debateKeyFor(state.current && state.current.id)) === '1'; } catch (e) { DEBATE.on = false; }
    if (HF) HF.on = false;   // el microfono se abre con un gesto (toggle), no al cargar el chat
    DEBATE.turns = 0;
    // Si quedo el perfil de solo lectura aplicado sin debate (cierre de pestana, crash), se
    // restaura; si el debate sigue prendido, se re-aplica.
    try {
      if (DEBATE.on) debateApplyToolProfile();
      else if (localStorage.getItem('aegis.debateProfile') === '1') debateRestoreToolProfile();
    } catch (e) {}
    debateSyncBtn();
    return DEBATE.on;
  }
  function debateSyncBtn() {
    const b = document.getElementById('btn-debate');
    if (!b || !DEBATE) return;
    b.classList.toggle('on', !!DEBATE.on);
    b.textContent = DEBATE.on ? 'Debate · ON' : (HF && HF.on ? 'Manos libres' : 'Debate');
    b.setAttribute('aria-pressed', DEBATE.on ? 'true' : 'false');
    b.title = DEBATE.on
      ? 'Modo debate ENCENDIDO: el bot conversa y NO puede usar herramientas. Decí "dale" para pasar a trabajar.'
      : 'Modo debate: discutir el plan antes de que el bot toque nada (sin herramientas).';
  }
  function debateCurrentMode() {
    const m = state.current && state.current.modes;
    return (m && (m.currentModeId || m.current_mode_id)) || 'auto';
  }
  function debateEffortNow() {
    const opts = (state.current && state.current.configOptions) || [];
    const opt = opts.find((o) => o && o.id === 'thinking_effort');
    return opt ? String(opt.currentValue || '') : '';
  }
  async function debateSetEffort(value) {
    const sid = state.current && state.current.id;
    if (!sid || !value) return false;
    try {
      const r = await rpc.request('session/set_config_option', { sessionId: sid, configId: 'thinking_effort', value: value });
      if (r && Array.isArray(r.configOptions) && state.current) state.current.configOptions = r.configOptions;
      renderChips();
      return true;
    } catch (e) {
      report('debate', 'no pude fijar thinking_effort=' + value + ': ' + String((e && e.message) || e).slice(0, 120));
      return false;
    }
  }
  // Perfil de solo lectura del debate: reads permitidos, escritura y shell negados por el server.
  var READ_ONLY_TOOLS = ['read_file', 'grep', 'tree', 'read_image', 'websearch__web_fetch', 'websearch__web_search', 'load_skill', 'load', 'chatrecall__chatrecall', 'extensionmanager__search_available_extensions'];
  var DEBATE_BLOCKED_TOOLS = ['shell', 'edit', 'write', 'delegate', 'scheduler__manage_schedule', 'extensionmanager__manage_extensions'];
  async function debateSetPerms(entries) {
    const sid = state.current && state.current.id;
    if (!sid) return false;
    try {
      // sessionId: el perfil es por sesion y vive en memoria del server, asi que debatir no
      // bloquea shell/edit/write en las otras sesiones ni deja permission.yaml de solo lectura.
      await rpc.request('_aegis/unstable/tools/permissions/set', { toolPermissions: entries, sessionId: sid });
      return true;
    } catch (e) {
      report('debate', 'permisos: ' + String((e && e.message) || e).slice(0, 140));
      return false;
    }
  }
  async function debateApplyToolProfile() {
    const ok = await debateSetPerms(DEBATE_BLOCKED_TOOLS.map((t) => ({ toolName: t, permission: 'never_allow' }))
      .concat(READ_ONLY_TOOLS.map((t) => ({ toolName: t, permission: 'always_allow' }))));
    if (ok) { try { localStorage.setItem('aegis.debateProfile', '1'); } catch (e) {} }
    return ok;
  }
  async function debateRestoreToolProfile() {
    // Lista vacia = el server borra los overrides de la sesion. No se reescribe permission.yaml:
    // lo que hubiera configurado el operador queda como estaba.
    const ok = await debateSetPerms([]);
    if (ok) { try { localStorage.removeItem('aegis.debateProfile'); } catch (e) {} }
    return ok;
  }
  async function debateSetMode(modeId) {
    const sid = state.current && state.current.id;
    if (!sid) return false;
    try {
      await rpc.request('session/set_mode', { sessionId: sid, modeId: modeId });
      if (state.current) {
        if (!state.current.modes) state.current.modes = {};
        state.current.modes.currentModeId = modeId;
      }
      return true;
    } catch (e) {
      systemNote('No pude cambiar el modo a ' + modeId + ': ' + String((e && e.message) || e).slice(0, 120));
      return false;
    }
  }
  async function debateToggle() {
    const next = !(DEBATE && DEBATE.on);
    if (next) {
      DEBATE.prev = debateCurrentMode();
      if (!(await debateSetMode('auto'))) return;   // tools habilitadas + perfil de solo lectura
      await debateApplyToolProfile();
    } else if (!(await debateSetMode(DEBATE.prev || 'auto'))) return;
    DEBATE.on = next;
    try { localStorage.setItem(debateKeyFor(state.current && state.current.id), next ? '1' : '0'); } catch (e) {}
    debateSyncBtn();
    if (next) {
      HF.on = true;
      if (!READ_ON) readToggle(true);   // sin voz del bot no hay ciclo manos libres
      DEBATE.prevEffort = debateEffortNow() || 'off';
      // Siempre (idempotente): la opcion puede decir off mientras request_params trae max.
      // Desde v71 el server pisa el parametro crudo, que es el que viaja al API.
      await debateSetEffort('off');
      await enforceFixedModel();   // open_design/opencode_go: modelo fijo (regla del operador)
      systemNote('Modo debate: micrófono abierto y respuestas en voz alta. Hablá; decí "dale" para que ejecute.');
      if (!state.busy && !AUD.playing && !AUD.q.length) micStart({ auto: true });
      else handsFreeMaybe(800);
    } else {
      HF.on = false;
      if (DEBATE.prevEffort) await debateSetEffort(DEBATE.prevEffort);
      await debateRestoreToolProfile();
      if (MIC.rec) { if (MIC.spoke) micStop(); else micStop(true); }
      systemNote('Modo trabajo: herramientas habilitadas.');
    }
    debateSyncBtn();   // la etiqueta depende de DEBATE y de HF: refrescar despues de tocar HF
  }
  function debateDecorate(text) {
    const t = String(text || '');
    if (!DEBATE || !DEBATE.on) return t;
    if (debateIsSettle(t)) return t;
    return DEBATE_PREAMBLE + '\n\n' + t;
  }
  // Cierre del debate: el mensaje del usuario solo dispara la conclusion.
  function debateIsSettle(text) {
    if (!DEBATE || !DEBATE.on) return false;
    const t = String(text || '').trim();
    if (!t || t.length > 240) return false;
    if (/\bno\s+(\w+\s+){0,2}(dale|hacelo|ejecut\w*|arranc\w*)/i.test(t)) return false;
    return VOICE_SETTLE.test(t);
  }
  async function debateConclude(userText) {
    const cur = state.current;
    if (!cur) return;
    const extra = String(userText || '').replace(VOICE_SETTLE, '').replace(/^[\s,.:;-]+/, '').trim();
    const turns = Math.max(1, DEBATE.turns || 1);
    // 1) el bot escribe el plan final (sigue en modo chat: no puede tocar nada)
    const instr = 'Cerrá el debate. Escribí UN solo mensaje con el plan final acordado: concreto, en imperativo, con el orden de los pasos y lo que NO hay que tocar. No menciones la discusión ni lo que descartamos, no uses herramientas y no incluyas el bloque "Para escuchar" ni encabezados de lectura (este mensaje se manda tal cual como pedido).'
      + (extra ? ' El usuario agrega: ' + extra : '')
      + ' Si en la conversación NO hay trabajo concreto para hacer (fue solo charla), respondé exactamente SIN-PLAN y nada más.';
    DEBATE.on = false;   // el turno de cierre no lleva preambulo
    DEBATE.closing = true;   // y NO se lee en voz alta
    await sendText(instr);
    DEBATE.closing = false;
    const plan = String(textoDelTurno || '').trim();
    const sinPlan = !plan || /^sin[\s_-]?plan\b/i.test(plan);
    if (sinPlan) {
      // Solo charla: se oculta el turno artificial de cierre y la conversacion queda.
      await debateHide(1);
      await debateSetMode('auto');
      if (DEBATE.prevEffort) await debateSetEffort(DEBATE.prevEffort);
      await debateRestoreToolProfile();
      DEBATE.on = false; DEBATE.turns = 0; HF.on = false;
      try { localStorage.setItem(debateKeyFor(cur.id), '0'); } catch (e) {}
      debateSyncBtn();
      systemNote('Debate cerrado sin plan: queda como conversación (no mando nada al agente).');
      return;
    }
    // 2) el debate entero (incluido el cierre) sale del contexto del agente
    const ocultos = await debateHide(turns + 1);
    // 3) modo trabajo + esfuerzo y modelo originales, y el plan va como mensaje nuevo
    await debateSetMode('auto');
    if (DEBATE.prevEffort) await debateSetEffort(DEBATE.prevEffort);
    await debateRestoreToolProfile();
    DEBATE.turns = 0;
    try { localStorage.setItem(debateKeyFor(cur.id), '0'); } catch (e) {}
    debateSyncBtn();
    if (!plan) {
      systemNote('El debate cerró sin plan: no mando nada al agente (quedó oculto igual).');
      return;
    }
    systemNote('Debate cerrado (' + ocultos + ' mensaje(s) fuera del contexto): el plan va como mensaje y el agente arranca.');
    await sendText(plan);
  }
  // Un turno de debate no debe engordar el contexto del agente: se marca agentVisible=false
  // con el mismo rewind que usa el boton de rebobinar. Queda visible (gris) en el transcript.
  // El bot cerro el debate solo (linea "fin del debate"): se apaga el modo y la charla queda.
  async function debateAutoClose() {
    DEBATE.on = false;
    DEBATE.turns = 0;
    await debateSetMode('auto');
    if (DEBATE.prevEffort) await debateSetEffort(DEBATE.prevEffort);
    await debateRestoreToolProfile();
    try { localStorage.setItem(debateKeyFor(state.current && state.current.id), '0'); } catch (e) {}
    debateSyncBtn();
    systemNote('El bot cerró el debate: seguimos charlando, sin plan de trabajo.');
  }
  function debatePlanFrom(text) {
    const t = String(text || '');
    const m = /(?:^|\n)[^\n]*plan final[^\n]*\n([\s\S]+)$/i.exec(t);
    return m ? m[1].trim() : '';
  }
  async function debateFinishWithPlan(plan) {
    const turns = Math.max(1, DEBATE.turns || 1);
    DEBATE.on = false;
    const ocultos = await debateHide(turns);
    await debateSetMode('auto');
    if (DEBATE.prevEffort) await debateSetEffort(DEBATE.prevEffort);
    await debateRestoreToolProfile();
    DEBATE.turns = 0;
    try { localStorage.setItem(debateKeyFor(state.current && state.current.id), '0'); } catch (e) {}
    debateSyncBtn();
    systemNote('Debate cerrado (' + ocultos + ' mensaje(s) fuera del contexto): mando el plan y arranco.');
    await sendText(plan);
  }
  async function debateHide(back) {
    const cur = state.current;
    if (!cur) return 0;
    const n = Math.max(1, Number(back) || 1);
    try {
      const res = await rpc.request('_aegis/unstable/session/rewind', { sessionId: cur.id, back: n });
      const inner = $('#msg-inner') as HTMLElement | null;
      const users = inner ? [...inner.querySelectorAll<HTMLElement>(':scope > .msg-user')] : [];
      const firstHidden = users[Math.max(0, users.length - n)];
      if (firstHidden && firstHidden.dataset.mid) setHiddenFrom(cur.id, firstHidden.dataset.mid);
      if (inner && firstHidden) {
        let seen = false;
        for (const k of inner.children) { if (k === firstHidden) seen = true; if (seen) k.classList.add('hidden-from-agent'); }
      }
      markHiddenTail();
      const hidden = (res && res.hidden) || 0;
      report('debate', 'ocultos ' + hidden + ' mensaje(s) (' + n + ' turno(s))');
      return hidden;
    } catch (e) {
      report('debate', 'rewind del debate fallo: ' + String((e && e.message) || e).slice(0, 120));
      return 0;
    }
  }
  // Manos libres: microfono abierto + lectura encendida. El ciclo se cierra solo: escucha,
  // transcribe, envia, el bot contesta, se lee y el microfono vuelve a abrirse.
  function handsFreeOn() { return !!(HF && HF.on) && READ_ON; }
  function handsFreeMaybe(delay?) {
    if (!handsFreeOn() || state.busy || MIC.rec) return;
    if (document.visibilityState !== 'visible') return;
    if (MIC.denied) return;                    // permiso negado: no insistir
    if (AUD.playing || AUD.q.length) return;   // no escuchar mientras habla el bot (se oiria a si mismo)
    setTimeout(function () {
      if (handsFreeOn() && !state.busy && !MIC.rec && !AUD.playing && !AUD.q.length) micStart({ auto: true });
    }, typeof delay === 'number' ? delay : 700);
  }

  (function bindMic() {
    const btn = document.getElementById('btn-mic');
    if (btn) btn.addEventListener('click', function () {
      // Con manos libres activo y sin grabar, el toque APAGA el ciclo (si no, no habria stop).
      if (!MIC.rec && HF && HF.on) {
        HF.on = false;
        debateSyncBtn();
        systemNote('Manos libres apagado. Tocá el micrófono otra vez para dictar a mano.');
        return;
      }
      micStart();
    });
    const dbg = document.getElementById('btn-debate');
    if (dbg) dbg.addEventListener('click', function () { debateToggle(); });
  })();

  // Cuantos chunks de contenido trajo el turno en curso. Si termina en 0 y no fue cancelado, el
  // proveedor corto el stream sin mandar nada (caso real: gemini/antigravity cortando a mitad).
  let chunksTurn = 0;
  let textoDelTurno = '';

  // Compatibilidad con mensajes antiguos que sólo imprimían la ruta /dl/ en texto.
  // Los enlaces Markdown nuevos ya se renderizan como chips por el parser.
  const DESCARGAS_VISTAS = new Set<string>();
  let descargasTimer: any = null;
  function ofrecerDescargas() {
    const inner = document.querySelector('#msg-inner') as HTMLElement | null;
    if (!inner) return;
    const sid = (state.current && state.current.id) || '';
    const re = /\/dl\/([A-Za-z0-9._-]{1,120})/g;
    const mensajes = inner.querySelectorAll('.msg-a');
    for (const nodo of Array.from(mensajes) as HTMLElement[]) {
      const texto = (nodo.querySelector(':scope > .content') as HTMLElement | null)?.innerText || '';
      const enlaces = new Set(Array.from(nodo.querySelectorAll<HTMLAnchorElement>('.content a.dl-chip[href^="/dl/"]')).map((a) => decodeURIComponent(a.getAttribute('href')!.slice(4))));
      const legacyRow = nodo.querySelector(':scope > .dl-row');
      legacyRow?.querySelectorAll<HTMLAnchorElement>('a.dl-chip[href^="/dl/"]').forEach((a) => {
        if (enlaces.has(decodeURIComponent(a.getAttribute('href')!.slice(4)))) a.remove();
      });
      if (legacyRow && !legacyRow.children.length) legacyRow.remove();
      const nombres: string[] = [];
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(texto)) !== null) {
        const clave = sid + ':' + m[1];
        if (enlaces.has(m[1])) { DESCARGAS_VISTAS.add(clave); continue; }
        if (!DESCARGAS_VISTAS.has(clave)) {
          DESCARGAS_VISTAS.add(clave);
          nombres.push(m[1]);
        }
      }
      if (!nombres.length) continue;
      let row = nodo.querySelector(':scope > .dl-row') as HTMLElement | null;
      if (!row) {
        row = document.createElement('div');
        row.className = 'dl-row';
        nodo.appendChild(row);
      }
      for (const nombre of nombres) {
        const a = document.createElement('a');
        a.className = 'dl-chip';
        a.href = '/dl/' + encodeURIComponent(nombre);
        a.setAttribute('download', nombre);
        const ico = document.createElement('span');
        ico.className = 'dl-ico';
        ico.textContent = '\u2193';
        const et = document.createElement('span');
        et.textContent = nombre;
        a.append(ico, et);
        row!.appendChild(a);
      }
    }
  }
  const descargasObs = new MutationObserver(() => {
    clearTimeout(descargasTimer);
    descargasTimer = setTimeout(ofrecerDescargas, 400);
  });
  descargasObs.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Aviso de turno vacio + boton para reintentar el mismo mensaje.
  function avisoTurnoVacio(texto, atts) {
    systemNote('El turno volvió vacío: el proveedor cortó la respuesta y no llegó contenido. Podés reintentar.');
    const row = document.createElement('div');
    row.className = 'retry-row';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'retry-btn';
    b.textContent = 'Reintentar';
    b.addEventListener('click', function () { row.remove(); sendText(texto, atts); });
    row.appendChild(b);
    msgWrap().appendChild(row);
    scrollBottom();
  }

  async function sendText(text, atts?, bubble?) {
    if (debateIsSettle(text)) return debateConclude(text);   // "dale": cierra y manda el plan
    if (DEBATE && DEBATE.on) DEBATE.turns = (DEBATE.turns || 0) + 1;   // el debate SI ve su propio hilo
    const wire = debateDecorate(text); // en debate, el mensaje lleva la consigna
    chunksTurn = 0;
    textoDelTurno = '';
    // Turno nuevo: lo que llegue ahora lo ve el modelo aunque antes se haya rebobinado.
    state.hideTail = false;
    const el = bubble || addUser(text, false, atts);
    const sid = state.current && state.current.id; // dueño del turno: si te vas a otro chat, esa vista no se toca
    state.adopted = false;
    setBusy(true, 'Aegis está trabajando.');
    const turnStartedAt = runStart;
    markRun(sid, true);   // marca inmediata en la lista, aunque esta vista no sea la del turno
    let label = 'Respuesta completa';
    let loMandoComoIndicacion = false;
    try {
      const res = await promptConRetry(wire, atts, sid);
      if (!(state.current && state.current.id === sid)) { report('adopt', 'turno terminó en ' + (sid || '?') + ' con la vista en otro chat'); return; }
      if (res && res.usage && res.usage.totalTokens != null) setUsage({ used: res.usage.totalTokens });
      stopNote(res && res.stopReason);
      const sr = res && res.stopReason;
      if (chunksTurn === 0 && sr !== 'cancelled') avisoTurnoVacio(text, atts);
      if (sr === 'end_turn' && chunksTurn > 0) ofrecerDescargas();
      if (sr === 'cancelled') label = 'Turno detenido';
      else if (sr && sr !== 'end_turn') label = 'Turno interrumpido (' + sr + ')';
    } catch (e) {
      if (e && e.aegisNoConfirmado) {
        // El reintento no pudo verificar si el mensaje llego: no se reenvia a ciegas (eso duplicaba
        // el turno) y el texto vuelve al composer para que el usuario decida.
        label = 'No se pudo confirmar el envío';
        if (state.current && state.current.id === sid) {
          const inp = document.getElementById('input') as HTMLTextAreaElement | null;
          if (inp && !inp.value.trim()) { inp.value = text; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.focus(); }
        }
        systemNote('No pude confirmar si tu mensaje llegó (la conexión no volvió a tiempo). Te lo dejé en el composer: mirá si arriba quedó la respuesta y, si no, reenvialo.');
        return;
      }
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
        } else if (state.busy && runStart === turnStartedAt) {
          setBusy(false, label);
        }
        flushQueue();
      } else {
        report('adopt', 'turno de ' + (sid || '?') + ' cerrado sin tocar la vista actual');
      }
      // Punto de reanudacion: lo que se mando despues de un rebobinado es conversacion
      // visible, asi que el replay no debe ocultarlo (ver applyUpdate).
      if (sid && el && el.dataset && el.dataset.mid && hiddenFromId(sid)) setResume(sid, el.dataset.mid);
      markRun(sid, false);   // si cambiaste de chat, avisa al cerrar el turno
      refreshSessions();
    }
    if (DEBATE && DEBATE.on) {
      const plan = debatePlanFrom(textoDelTurno);
      if (plan) debateFinishWithPlan(plan);
      else if (/fin del debate/i.test(textoDelTurno)) debateAutoClose();
    }
    handsFreeMaybe(900);   // manos libres: el micro vuelve aunque la respuesta no se lea
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
    input.value = ''; autosize(); refreshSlashMenu(); saveDraft();
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
    input.value = ''; autosize(); refreshSlashMenu(); saveDraft();
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
    paintQueuedRunBar();
    setQueuedNote(el, 'se enviará al terminar el turno');
  }

  // Manda una indicación al run indicado y la deja en state.steers para saber si el
  // agente la levantó (eco user_message_chunk con el mismo messageId) o hay que reenviarla.
  async function steerTo(runId, text, atts, el, note?) {
    if (!rpc.ready || !state.current) return false;
    try {
      const res = await rpc.request('_aegis/unstable/session/steer', {
        sessionId: state.current.id,
        prompt: promptBlocks(text, atts || []),
        expectedRunId: runId,
      });
      const mid = (res && res.messageId) || null;
      if (mid) {
        state.steers.set(mid, { el, text, atts: atts || [] });
        paintQueuedRunBar();
        if (el && el.isConnected) el.dataset.mid = mid;
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
    paintQueuedRunBar();
    untrackPending(messageId);
    if (info.el) {
      info.el.classList.remove('queued');
      identifyUserBubble(info.el, messageId);
    }
    setQueuedNote(info, 'indicación recibida por el agente');
  }

  async function flushQueue() {
    if (state.busy || !state.queue.length) return;
    if (!rpc.ready) return; // sin backend: la cola espera a la reconexión
    const q = state.queue.slice();
    state.queue = [];
    paintQueuedRunBar();
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
  const WATCH_DBG: Record<string, any> = { ticks: 0, infos: 0, infoErrs: 0, keys: [], resyncs: 0, resyncMs: 0, maxResyncMs: 0, lastKey: '', prevKey: '', softResyncs: 0, softMs: 0, maxSoftMs: 0, softDeferred: 0, softThrottled: 0, interrupted: 0, lastSoft: null,
    // (v6.4) diagnóstico del hub por sesión (watch / replay / reconexión)
    hubWatches: 0, hubRewatches: 0, hubGaps: 0, hubErrs: 0, hubInfoErrs: 0, hubUnsupported: 0, hubRunStarts: 0, hubOrphanFrees: 0 };
  const RUN_WATCH_MS = 2500;
  let runWatch = 0;
  let watchKey = '';
  let watchSince = 0;
  const ADOPTED_NOTE = 'Turno en curso (lo arrancó otra conexión)';

  // ==================== v6.4: watch por sesión (fan-out del hub) ====================
  // El server v4 replica las notificaciones de una sesión a TODAS las conexiones
  // enganchadas (`_aegis/unstable/session/watch`): un turno ya no pertenece a la conexión
  // que lo arrancó, así que dos pestañas y el celular ven el mismo streaming y el fin de
  // turno llega como evento (`_aegis/unstable/session/update` con activeRunId=null);
  // session/info reconcilia si ese evento se pierde. Si el server no tiene el método (v2/v3) se marca
  // hubWatch=false y nada de esto corre: queda el comportamiento viejo (soft-poll +
  // sondeo por steer + orphan watch) tal como estaba.
  const HUB = { text: new Map(), kind: new Map(), gapRecovering: false, orphanMissAt: 0 };

  // El replay del hub se pinta con los MISMOS handlers que un evento vivo (onUpdate /
  // onAegisUpdate), en orden; los chunks de texto se acumulan en HUB.text y se reconcilian
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
      const info = await rpc.request('_aegis/unstable/session/info', { sessionId: state.current.id });
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
    try { await rpc.request('_aegis/unstable/session/unwatch', { sessionId }); } catch {}
  }

  // ¿La burbuja del usuario ya está pintada con ese messageId? (el load o el propio envío
  // pueden haberla puesto antes de que llegue el eco del hub: no se duplica).
  function userBubbleOnScreen(mid) {
    const nodes = document.querySelectorAll<HTMLElement>('#msg-inner .msg-user');
    for (let i = nodes.length - 1; i >= 0 && i >= nodes.length - 3; i--) if (nodes[i].dataset.mid === mid) return true;
    return false;
  }

  // El eco del prompt propio (burbuja local sin messageId) ahora también llega como
  // notificación: se le pega el id en vez de pintar una segunda burbuja igual.
  function adoptLocalEcho(mid, text) {
    const nodes = document.querySelectorAll<HTMLElement>('#msg-inner .msg-user');
    const needle = wordsOf(text);
    const matches: HTMLElement[] = [];
    for (let i = nodes.length - 1; i >= 0 && i >= nodes.length - 4; i--) {
      const el = nodes[i];
      if (el.dataset.mid || el.classList.contains('queued')) continue;
      const shown = wordsOf(el.textContent);
      if (shown && needle && (shown === needle || needle.startsWith(shown))) matches.push(el);
    }
    return matches.length === 1 && identifyUserBubble(matches[0], mid);
  }

  function adoptLocalImage(mid, content) {
    if (!content || !content.data || !content.mimeType) return false;
    const nodes = document.querySelectorAll<HTMLElement>('#msg-inner .msg-user');
    const src = 'data:' + content.mimeType + ';base64,' + content.data;
    const matches: HTMLElement[] = [];
    for (let i = nodes.length - 1; i >= 0 && i >= nodes.length - 4; i--) {
      const el = nodes[i];
      if (el.dataset.mid || el.classList.contains('queued')) continue;
      if ([...el.querySelectorAll('img')].some((img) => img.src === src)) matches.push(el);
    }
    return matches.length === 1 && identifyUserBubble(matches[0], mid);
  }

  // Aplica el replay de la respuesta de watch, en orden, por el mismo camino que un evento
  // vivo. Devuelve true si el hub avisó que truncó el ring (replay_gap).
  function hubApplyReplay(replay: Array<{method: string; params?: unknown}> | undefined): boolean {
    let gap = false;
    state.hubReplay = true;
    HUB.text.clear(); HUB.kind.clear();
    try {
      for (const n of replay || []) {
        if (!n || !n.method) continue;
        if (n.method === '_aegis/unstable/session/replay_gap') { gap = true; continue; }
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
  type WatchResult = 'ok' | 'gap' | 'unsupported' | 'error';
  async function watchSession(since: number | null, opts?: { quiet?: boolean }): Promise<WatchResult> {
    if (!state.current || !rpc.ready) return 'error';
    const sid = state.current.id;
    const revisionAtRequest = liveRunRevision;
    if (state.hubWatchSid && state.hubWatchSid !== sid) {
      const prev = state.hubWatchSid;
      state.hubWatchSid = null; state.hubCursor = null;
      hubUnwatch(prev);
    }
    try {
      // Un watch tardío no debe reenganchar silenciosamente la sesión tras el fallback.
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout>;
      const request = rpc.request('_aegis/unstable/session/watch', { sessionId: sid, since: since == null ? null : since });
      request.then(() => { if (timedOut && state.current?.id !== sid) hubUnwatch(sid); }).catch(() => {});
      const res = await Promise.race([
        request,
        new Promise((resolve) => { timeout = setTimeout(() => { timedOut = true; resolve(null); }, 8000); }),
      ]);
      clearTimeout(timeout);
      if (res === null) {
        if (state.current?.id === sid) state.hubWatch = false;
        report('watch', 'session/watch sin respuesta en 8 s: se mantiene el refresco viejo');
        return 'unsupported';
      }
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
      const rewound = typeof since === 'number' && res.cursor < since;
      state.hubCursor = rewound ? res.cursor : Math.max(state.hubCursor || 0, res.cursor);
      // El hub no manda watcherCount en la respuesta de watch: se lee de session/info.
      if (res && typeof res.watcherCount === 'number') state.hubWatchers = res.watcherCount;
      WATCH_DBG.hubWatches++;
      const liveRidBeforeReplay = state.runId;
      const gap = hubApplyReplay(res && res.replay);
      // El replay no puede rebobinar un run avisado en vivo mientras watch esperaba.
      if (liveRunRevision !== revisionAtRequest) state.runId = liveRidBeforeReplay;
      // Un cursor que RETROCEDE significa que el hub soltó el ring de la sesión (TTL de
      // inactividad) y volvió a empezar: lo tratamos como replay_gap y recargamos todo.
      // El estado de watch se aplica sólo si no llegó un aviso vivo mientras
      // se esperaba la respuesta; el replay puede contener estados anteriores.
      if (res && res.activeRunId !== undefined && liveRunRevision === revisionAtRequest) {
        applyActiveRunId(res.activeRunId || null);
      }
      if (!opts || !opts.quiet) report('watch', 'enganchado ' + sid.slice(0, 12) + ' cursor=' + state.hubCursor + ' replay=' + ((res && res.replay && res.replay.length) || 0) + (res && res.activeRunId ? ' run=' + res.activeRunId : ''));
      updateMetaHints();
      return (gap || rewound) ? 'gap' : 'ok';
    } catch (e) {
      if (hubMethodUnsupported(e)) {
        // Server v2/v3: no hay watch. Fallback COMPLETO al comportamiento viejo.
        state.hubWatch = false;
        state.hubWatchSid = null;
        WATCH_DBG.hubUnsupported = 1;
        report('watch', 'server sin _aegis/unstable/session/watch: se mantiene el refresco viejo (' + String((e && e.message) || '').slice(0, 120) + ')');
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

  // El hub puede perder el aviso terminal al reconectar: reconciliar con session/info
  // también para turnos adoptados, sin enviar un steer falso. Dos lecturas separadas
  // evitan cerrar durante la ventana de registro del run recién iniciado.
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
    if (!HUB.orphanMissAt) { HUB.orphanMissAt = performance.now(); return; }
    if (performance.now() - HUB.orphanMissAt < (run || state.adopted ? 4000 : 15000)) return;
    HUB.orphanMissAt = 0;
    WATCH_DBG.hubOrphanFrees++;
    report('adopt', 'fin del run confirmado por session/info');
    if (run || state.adopted) endRun('El turno terminó');
    else {
      systemNote('El turno anterior quedó sin cerrar (no hay run activo): se liberó la consola para seguir.');
      setBusy(false, 'Sin respuesta del turno anterior');
    }
  }

  // El estado del run llega por el hub y por la respuesta de watch. La revisión
  // impide que una respuesta atrasada de watch pise una notificación más nueva.
  let liveRunRevision = 0;
  function applyActiveRunId(rid) {
    if (!state.hubReplay) liveRunRevision++;
    const prev = state.runId;
    // Replay: sólo se registra el estado; decide la respuesta de watch (ver watchSession).
    if (state.hubReplay) { state.runId = rid || null; return state.runId; }
    if (rid) HUB.orphanMissAt = 0;
    if (rid && prev && rid !== prev && state.busy) speedStart(); // otro run: no heredar muestras
    state.runId = rid || null;
    if (rid && state.busy) state.speed.runId = rid;
    if (rid) {
      if (!prev) WATCH_DBG.hubRunStarts++;
      // Run vivo que no arrancamos nosotros (otra pestaña, el celular, un reload): se adopta
      // (barra + Detener) y el streaming llega igual, porque somos watchers de la sesión.
      if (!state.busy) { unsweepInterruptedTools(); adoptRun(rid, ADOPTED_NOTE); }
      return rid;
    }
    if (!state.busy) return null;
    if (!prev && !state.adopted) {
      // El dueño aún puede estar enviando el prompt. Confirmar null en session/info
      // antes de cerrar evita que un terminal anterior cierre este turno.
      void hubOrphanTick();
      return null;
    }
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
      const res = await rpc.request('_aegis/unstable/session/steer', {
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

  function adoptRun(runId, note, startedAt?) {
    state.adopted = true;
    stopOrphanWatch(); // en adoptado vigila watchAdoptedRun
    if (runId) state.runId = runId;
    const text = note || ADOPTED_NOTE;
    if (!state.busy) setBusy(true, text, startedAt);
    else if (!$('#runbar')?.classList.contains('cancelling')) setRunBarText(text); // no pisamos "Deteniendo…"
    startRunWatch();
  }

  function startRunWatch() {
    // El hub recibe streaming; session/info queda como reconciliación de terminales perdidos.
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
    const info = await rpc.request('_aegis/unstable/session/info', { sessionId: cur.id }).then((v) => { WATCH_DBG.infos++; return v; }).catch(() => { WATCH_DBG.infoErrs++; return null; });
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
    const info = await rpc.request('_aegis/unstable/session/info', { sessionId: cur.id }).catch(() => null);
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
  function settleSteers(delayMs?) {
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
    if (!(probe.known && probe.runId)) { const _m = await rpc.request('_aegis/unstable/session/info', { sessionId: state.current.id }).then((v) => (v && v.session && v.session._meta) || {}).catch(() => ({})); const _fresh = _m.lastMessageAt ? (Date.now() - Date.parse(_m.lastMessageAt)) < 150000 : false; if (_fresh) { unsweepInterruptedTools(); if (!state.busy) setBusy(true, 'Turno en curso (recuperado tras recargar)'); startHotWatch(); return true; } }
    // Antes esto corria dentro de renderSession, es decir ANTES de adoptar: una carta
    // pendiente de un run que si estaba vivo quedaba marcada como interrumpida.
    sweepInterruptedTools();
    if (!state.busy) flushPendingSteers();
    return false;
  }

  // ---------- chips (config options) ----------
  // Los chips (modelo, esfuerzo) vienen de la sesion. Para poder elegir ANTES del primer mensaje se
  // guarda una cache de las ultimas opciones vistas y la eleccion pendiente, que se aplica con
  // session/set_config_option apenas se crea el chat.
  function leerCacheChips() {
    try { const j = JSON.parse(localStorage.getItem('aegis.chipCache') || '[]'); return Array.isArray(j) ? j : []; } catch (e) { return []; }
  }
  function guardarCacheChips(opts) {
    try { localStorage.setItem('aegis.chipCache', JSON.stringify((opts || []).slice(0, 8))); } catch (e) {}
  }
  // Modelo/esfuerzo pendientes: por workspace si se conoce la carpeta, con el global como respaldo.
  // Asi abrir un chat en ROLEPLAY AI no arrastra el modelo elegido para Aegis.
  function pendientesKey(cwd?: string): string {
    const base = 'aegis.pendingConfig';
    if (!cwd) return base;
    const raw = String(cwd).toLowerCase();
    const clean = raw.startsWith('\\\\?\\') ? raw.slice(4) : raw;
    const slug = clean.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base + '.' + slug;
  }

  function leerPendientes(cwd?: string) {
    try {
      const per = cwd ? localStorage.getItem(pendientesKey(cwd)) : null;
      const j = JSON.parse(per || localStorage.getItem(pendientesKey()) || '{}');
      return j && typeof j === 'object' ? j : {};
    } catch (e) { return {}; }
  }
  function guardarPendientes() {
    try { localStorage.setItem('aegis.pendingConfig', JSON.stringify(state.pendingConfig || {})); } catch (e) {}
    try {
      const cwd = state.current && state.current.cwd;
      if (cwd) {
        localStorage.setItem(pendientesKey(cwd), JSON.stringify(state.pendingConfig || {}));
        saveWsDefaults(cwd, state.pendingConfig || {});
      }
    } catch (e) {}
  }
  async function aplicarPendientes(sessionId) {
    const pend = state.pendingConfig || {};
    const ids = Object.keys(pend);
    if (!ids.length) return;
    // The provider switch replaces the model list; apply it before any model choice.
    const ordered = ids.sort((a, b) => (a === 'provider' ? -1 : b === 'provider' ? 1 : 0));
    for (const configId of ordered) {
      try {
        const res = await rpc.request('session/set_config_option', { sessionId, configId, value: pend[configId] });
        if (res && Array.isArray(res.configOptions) && state.current) state.current.configOptions = res.configOptions;
      } catch (e) {
        // No se oculta: si el servidor rechaza la opcion el usuario tiene que enterarse.
        systemNote('No se pudo aplicar «' + configId + '» elegido antes de crear el chat: ' + (e && e.message ? e.message : e));
      }
    }
    // Verificacion: el servidor puede aceptar la llamada y NO aplicar el cambio (medido con
    // "provider": se pedia aegis y la sesion quedaba en open_design). Se compara lo que quedo y, si
    // no coincide, se avisa en pantalla en vez de dejar creer que la eleccion se aplico.
    const quedo = {};
    for (const o of (state.current && state.current.configOptions) || []) {
      if (o && o.id) quedo[o.id] = o.currentValue;
    }
    const sinAplicar = ids.filter((id) => {
      if (quedo[id] === undefined || quedo[id] === pend[id]) return false;
      // El valor "por defecto" (el chip "Aegis (Default)") no se refleja como tal: el servidor
      // resuelve el default real (hoy open_design), asi que un valor distinto es lo esperado.
      const opcion = ((state.current && state.current.configOptions) || []).find((o) => o && o.id === id);
      const etiqueta = opcion && Array.isArray(opcion.options) ? ((opcion.options.find((o) => o.value === pend[id]) || {}).name || '') : '';
      return !/default/i.test(etiqueta);
    });
    if (sinAplicar.length) {
      systemNote(
        'Ojo: la elección hecha antes de crear el chat no quedó aplicada (' + sinAplicar.join(', ') +
          '). Cambiala con los selectores de arriba, ya con el chat abierto.'
      );
    }
    state.pendingConfig = {};
    guardarPendientes();
    renderChips();
  }
  // El servidor manda algunas opciones sin nombre (modos: auto, approve, smart_approve, chat):
  // mostrarlas crudas con guion bajo queda feo. Se separan las palabras y se capitaliza.
  function etiquetaOpcion(o) {
    const bruto = String((o && (o.name || o.value)) || '');
    if (!bruto || bruto.indexOf('_') === -1) return bruto;
    return bruto.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }

  // ---- migracion v52: el esfuerzo ya no viaja en el id del modelo --------------------
  // Hasta v51 cada esfuerzo era un modelo propio (`glm-5.3-flash-low`). Una sesion vieja lo
  // tiene guardado y el picker nuevo ya no lo ofrece, asi que la barra mostraba un modelo
  // inexistente al lado de un chip de esfuerzo que lo contradecia. Al abrir el chat se
  // normaliza a la familia base + el esfuerzo equivalente, una sola vez por sesion.
  const LEGACY_MODEL = /^(deepseek-v4\.1-flash|glm-5\.3-flash|gemini-3\.8-flash)-(none|low|medium|high|max)$/;
  const migradas = new Set<string>();
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
    rpc
      .request("session/set_config_option", { sessionId: cur.id, configId: "model", value: base })
      .then((r) => {
        if (r && Array.isArray(r.configOptions)) cur.configOptions = r.configOptions;
        const effortOpt = (cur.configOptions || []).find((o) => o && o.id === "thinking_effort");
        if (!effortOpt || !(effortOpt.options || []).some((o) => o && o.value === esfuerzo)) return null;
        return rpc.request("session/set_config_option", { sessionId: cur.id, configId: "thinking_effort", value: esfuerzo });
      })
      .then((r) => {
        if (r && Array.isArray(r.configOptions)) cur.configOptions = r.configOptions;
        renderChips();
      })
      .catch(() => { /* si el server no lo acepta queda como estaba: el sufijo sigue funcionando */ })
      .finally(() => { migrando = false; });
  }

  // Esfuerzo por modelo: en vez de un chip aparte que ocupa lugar en la barra, cada fila del
  // menu de modelos abre un flyout al costado con sus esfuerzos. El chip de "esfuerzo" del
  // servidor sigue existiendo como configOption, pero se deja de dibujar: el valor se cambia
  // desde la fila del modelo (un solo gesto) y se recuerda por modelo.
  const EFFORT_ES: Record<string, string> = { off: 'Sin razonamiento', none: 'Sin razonamiento', low: 'Bajo', medium: 'Medio', high: 'Alto', max: 'Máximo' };
  const EFFORT_BARS: Record<string, number> = { off: 1, none: 1, low: 2, medium: 3, high: 4, max: 5 };
  const effortByModelKey = 'aegis.effortByModel';
  function effortByModel(): Record<string, string> {
    try { const j = JSON.parse(localStorage.getItem(effortByModelKey) || '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
  }
  function rememberEffort(model: string, effort: string) {
    if (!model || !effort) return;
    try { const m = effortByModel(); m[model] = effort; localStorage.setItem(effortByModelKey, JSON.stringify(m)); } catch {}
  }
  function effortLabel(v: string) { return EFFORT_ES[v] || v; }
  function effortBars(v: string) {
    const n = EFFORT_BARS[v] || 1;
    let out = '<span class="fly-bars" aria-hidden="true">';
    for (let i = 1; i <= 5; i++) out += '<i' + (i <= n ? ' class="on"' : '') + '></i>';
    return out + '</span>';
  }

  // Coloca un flyout al costado de su fila: derecha, si no entra izquierda, y si tampoco
  // (telefono) debajo de la fila con el ancho del menu. Nunca fuera del viewport.
  function openFly(row: HTMLElement, fly: HTMLElement) {
    if (fly.parentElement !== document.body) document.body.appendChild(fly);
    fly.hidden = false;
    const r = row.getBoundingClientRect();
    const w = fly.offsetWidth;
    const h = fly.offsetHeight;
    const m = 8;
    let left = r.right + 6;
    if (left + w > window.innerWidth - m) left = r.left - w - 6;
    let top = r.top;
    if (left < m) { left = Math.min(Math.max(m, r.left), Math.max(m, window.innerWidth - m - w)); top = r.bottom + 6; }
    if (top + h > window.innerHeight - m) top = Math.max(m, window.innerHeight - m - h);
    if (top < m) top = m;
    fly.style.left = Math.round(left) + 'px';
    fly.style.top = Math.round(top) + 'px';
    fly.style.maxHeight = Math.max(120, window.innerHeight - 2 * m) + 'px';
    row.classList.add('fly-open');
    row.setAttribute('aria-expanded', 'true');
  }
  function closeFlys(keep?: HTMLElement) {
    document.querySelectorAll<HTMLElement>('body > .menu-fly').forEach((f) => {
      if (keep && f === keep) return;
      f.hidden = true;
      f.remove();
    });
    document.querySelectorAll<HTMLElement>('.menu-row.fly-open').forEach((r) => {
      r.classList.remove('fly-open');
      r.setAttribute('aria-expanded', 'false');
    });
  }

  // Estado del flyout mientras el menú de modelos está abierto.
  let flyTimer = 0;
  let flyHover = false;
  // Volver del flyout a la fila (Escape / flecha izquierda) enfoca la fila, y el focusin de la
  // fila abriria el flyout otra vez: esta ventana corta ese rebote.
  let flySuppressUntil = 0;
  function cerrarFlyYVolver() {
    const padre = document.querySelector<HTMLElement>('.menu-row.fly-open');
    flySuppressUntil = Date.now() + 350;
    closeFlys();
    if (padre && padre.isConnected) { padre.focus(); return true; }
    return false;
  }
  let effortOptions: any[] = [];
  let effortGlobal = '';
  let effortMemo: Record<string, string> = {};
  let modeloActual = '';
  function effortActualDe(model: string, globalEffort: string, memo: Record<string, string>): string {
    const g = globalEffort || 'off';
    if (!model || model === modeloActual) return g;
    return memo[model] || g;
  }
  function abrirFly(row: HTMLElement, modelValue: string, focusPrimero?: boolean) {
    const key = modelValue + '|' + row.dataset.rowKey;
    const ya = document.querySelector<HTMLElement>('body > .menu-fly');
    if (ya && ya.dataset.key === key) { if (focusPrimero) (ya.querySelector<HTMLElement>('.menu-row.sel') || ya.querySelector<HTMLElement>('.menu-row'))?.focus(); return; }
    closeFlys();
    const act = effortActualDe(modelValue, effortGlobal, effortMemo);
    const fly = document.createElement('div');
    fly.className = 'menu menu-fly';
    fly.dataset.key = key;
    fly.dataset.model = modelValue;
    fly.innerHTML = '<div class="menu-label">Esfuerzo · ' + esc(etiquetaOpcion({ value: modelValue, name: modelValue })) + '</div>';
    for (const e of effortOptions) {
      const r = document.createElement('button');
      r.type = 'button';
      r.className = 'menu-row' + (e.value === act ? ' sel' : '');
      r.setAttribute('role', 'menuitem');
      // Nombre humano cuando el valor es un nivel conocido; el crudo queda en el title.
      r.innerHTML = effortBars(String(e.value)) + '<span>' + esc(effortLabel(String(e.value)) || etiquetaOpcion(e)) + '</span>';
      r.title = String(e.value);
      r.addEventListener('click', (ev) => { ev.stopPropagation(); void elegirModeloYEffort(modelValue, String(e.value)); });
      r.addEventListener('pointerenter', () => { flyHover = true; });
      fly.appendChild(r);
    }
    fly.addEventListener('pointerenter', () => { flyHover = true; });
    fly.addEventListener('pointerleave', () => { flyHover = false; });
    // El flyout no pasa por openMenu: sin esto no tendría navegación con flechas ni Escape
    // devolviendo el foco a la fila del modelo.
    wireMenuKeys(fly);
    openFly(row, fly);
    if (focusPrimero) (fly.querySelector<HTMLElement>('.menu-row.sel') || fly.querySelector<HTMLElement>('.menu-row'))?.focus();
  }
  // Un solo gesto: modelo + esfuerzo. El orden importa (el modelo primero puede resetear el
  // esfuerzo soportado). Si el modelo es fijo por proveedor, setConfig lo rechaza y no se
  // cambia nada: se avisa con la nota que ya existe.
  async function elegirModeloYEffort(model: string, effort: string) {
    closeFlys();
    closeMenus();
    if (model && model !== modeloActual) await aplicarConfig('model', model);
    if (effort && effort !== effortGlobal) await aplicarConfig('thinking_effort', effort);
    rememberEffort(model, effort);
    renderChips();
  }

  function renderChips() {
    const wrap = $('#chips');
    wrap.innerHTML = '';
    document.querySelectorAll('body > .menu').forEach((m) => m.remove()); // limpia menús "portal" previos
    const deLaSesion = state.current && Array.isArray(state.current.configOptions) && state.current.configOptions.length ? state.current.configOptions : null;
    if (deLaSesion) guardarCacheChips(deLaSesion);
    // Sin chat abierto, los chips salen de la cache: asi se puede elegir modelo antes del primer mensaje.
    const opts = deLaSesion || leerCacheChips();
    const providerOpt = opts.find((o) => o && o.id === 'provider');
    if (!deLaSesion && providerOpt && !providerOpt.options.some((o) => o.value === 'opencode_go')) {
      providerOpt.options.push({ value: 'opencode_go', name: 'OpenCode Go' });
    }
    // Esfuerzos disponibles: salen del configOption del server, pero se consumen desde la fila
    // del modelo (flyout al costado) en vez de un chip propio en la barra.
    const effortOpt = opts.find((o) => o && o.id === 'thinking_effort' && o.type === 'select' && Array.isArray(o.options) && o.options.length > 1);
    effortOptions = (effortOpt && effortOpt.options) || [];
    const effortNow = String((effortOpt && effortOpt.currentValue) || '');
    const memorizado = effortByModel();
    effortOptions = (effortOpt && effortOpt.options) || [];
    effortGlobal = effortNow;
    effortMemo = memorizado;
    modeloActual = String(((opts.find((o) => o && o.id === 'model') || {} as any).currentValue) || '');
    for (const opt of opts) {
      if (opt.type !== 'select' || !Array.isArray(opt.options) || opt.options.length <= 1) continue;
      if (opt.id === 'thinking_effort' && effortOpt) continue; // se elige desde el modelo
      const esModelo = opt.id === 'model' && !!effortOpt;
      const item = document.createElement('div');
      item.className = 'chip-wrap';
      item.dataset.opt = opt.id;
      const btn = document.createElement('button');
      btn.className = 'chip' + (esModelo ? ' chip-model' : '');
      btn.type = 'button';
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      const cur = opt.options.find((o) => o.value === opt.currentValue) || opt.options[0];
      const etiqueta = (cur && (cur.name || cur.value)) || opt.name || opt.id;
      const effChip = esModelo ? effortActualDe(String(opt.currentValue), effortNow, memorizado) : '';
      btn.innerHTML = '<span class="chip-t">' + esc(etiqueta) + '</span>'
        + (esModelo && effChip ? '<span class="chip-eff">' + esc(effortLabel(effChip)) + '</span>' : '');
      btn.title = (opt.name || opt.id) + (esModelo ? ' · el esfuerzo se elige al costado de cada modelo' : '');
      const menu = document.createElement('div');
      menu.className = 'menu' + (esModelo ? ' menu-model' : '');
      menu.hidden = true;
      menu.innerHTML = `<div class="menu-label">${esc(opt.name || opt.id)}</div>`
        + (esModelo ? '<div class="menu-hint">Pasá por un modelo y elegí el esfuerzo al costado</div>' : '');
      for (const o of opt.options) {
        const row = document.createElement('button');
        row.className = 'menu-row' + (o.value === opt.currentValue ? ' sel' : '');
        row.type = 'button';
        row.setAttribute('role', 'menuitem');
        row.dataset.rowKey = String(o.value);
        if (esModelo && effortOptions.length) {
          const efRow = effortActualDe(String(o.value), effortNow, memorizado);
          row.innerHTML = '<span class="mr-main"><span class="mr-name">' + esc(etiquetaOpcion(o)) + '</span>'
            + '<span class="mr-eff">' + effortBars(efRow) + '<span class="mr-eff-t">' + esc(effortLabel(efRow)) + '</span></span></span>'
            + '<span class="mr-fly-chev" aria-hidden="true">' + uiIcon('chevron', { size: 11 }) + '</span>';
          row.setAttribute('aria-haspopup', 'menu');
          row.setAttribute('aria-expanded', 'false');
          row.addEventListener('pointerenter', () => { clearTimeout(flyTimer); flyTimer = setTimeout(() => abrirFly(row, String(o.value)), 90); });
          // Al salir de la fila no se cierra de golpe: si el mouse entra al flyout (que esta al
          // costado, con 6px de aire) la ventana de 260 ms evita el parpadeo.
          row.addEventListener('pointerleave', () => {
            clearTimeout(flyTimer);
            flyTimer = setTimeout(() => { if (!flyHover) closeFlys(); }, 260);
          });
          row.addEventListener('focusin', () => { if (Date.now() > flySuppressUntil) abrirFly(row, String(o.value)); });
          row.addEventListener('click', (e) => {
            e.stopPropagation();
            clearTimeout(flyTimer);
            abrirFly(row, String(o.value));
          });
          const onKey = (e: KeyboardEvent) => {
            if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); abrirFly(row, String(o.value), true); }
          };
          row.addEventListener('keydown', onKey);
        } else {
          row.innerHTML = `<span>${esc(etiquetaOpcion(o))}</span>`;
          row.addEventListener('click', async (e) => {
            e.stopPropagation();
            menu.hidden = true;
            await setConfig(opt.id, o.value);
          });
        }
        menu.appendChild(row);
      }
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasHidden = menu.hidden;
        closeFlys();
        closeMenus();
        if (wasHidden) openMenu(btn, menu);
      });
      item.append(btn, menu);
      wrap.appendChild(item);
    }
    // Chip de modo debate: vive con los chips de modelo/modo y no gasta lugar en el composer.
    const dwrap = document.createElement('div');
    dwrap.className = 'chip-wrap';
    const dbtn = document.createElement('button');
    dbtn.id = 'btn-debate';
    dbtn.type = 'button';
    dbtn.className = 'chip debate-chip';
    dbtn.addEventListener('click', function (e) { e.stopPropagation(); debateToggle(); });
    dwrap.appendChild(dbtn);
    wrap.appendChild(dwrap);
    debateSyncBtn();
    // v52: normaliza sesiones que todavia tienen el esfuerzo dentro del id del modelo.
    migrarModeloViejo();
  }

  // Los menús se mueven al <body> al abrirse (patrón portal) y se posicionan
  // con coordenadas fijas: inmunes a contenedores con overflow, máscaras
  // (el scroll de chips en móvil) o contextos de apilado intermedios.
  // v4 teclado: role=menu/menuitem, foco en la primera opcion al abrir,
  // flechas/Home/End para recorrer, Esc devuelve el foco al disparador.
  let menuTrigger: HTMLElement | null = null;
  function menuItems(menu: HTMLElement): HTMLElement[] {
    return [...menu.querySelectorAll<HTMLElement>('.menu-row:not([disabled])')];
  }
  function wireMenuKeys(menu: HTMLElement) {
    if (menu.dataset.keys === '1') return;
    menu.dataset.keys = '1';
    menu.addEventListener('keydown', (e: KeyboardEvent) => {
      const items = menuItems(menu);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const move = (n: number) => {
        e.preventDefault();
        items[(i + n + items.length) % items.length].focus();
      };
      if (e.key === 'ArrowDown') move(1);
      else if (e.key === 'ArrowUp') move(-1);
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === 'ArrowLeft' && menu.classList.contains('menu-fly')) {
        // Volver del flyout de esfuerzo a la fila del modelo que lo abrio.
        e.preventDefault();
        e.stopPropagation();
        if (!cerrarFlyYVolver()) closeFlys();
      }
      else if (e.key === 'ArrowRight' && menu.classList.contains('menu-model')) {
        const fila = document.activeElement as HTMLElement | null;
        if (fila && fila.classList.contains('menu-row')) {
          e.preventDefault();
          e.stopPropagation();
          fila.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
      }
      else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // La fila abre un menu efimero (se recrea en cada apertura): se descarta. El flyout
        // devuelve el foco a la fila que lo abrio (y no se reabre: ver flySuppressUntil).
        if (menu.classList.contains('menu-fly')) {
          if (cerrarFlyYVolver()) return;
          closeFlys();
          return;
        }
        if (menu.classList.contains('row-menu')) menu.remove();
        else menu.hidden = true;
        if (menuTrigger && menuTrigger.isConnected) menuTrigger.focus();
      }
    });
  }
  function openMenu(btn, menu) {
    menuTrigger = btn instanceof HTMLElement ? btn : null;
    menu.setAttribute('role', 'menu');
    wireMenuKeys(menu);
    if (menuTrigger) menuTrigger.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    menu.hidden = false; // medir con el menú ya visible (si no, offsetHeight = 0)
    const h = menu.offsetHeight;
    let top = r.bottom + 7;
    // Si abajo no hay lugar (fila cerca del borde inferior), el menú se abre hacia arriba:
    // antes quedaba fuera del viewport y no se podía tocar.
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 7);
    menu.style.top = Math.round(top) + 'px';
    // Horizontal: el borde derecho del menú se alinea con el del chip, pero acotado al viewport.
    // Antes no había tope a la IZQUIERDA: en el celular (menú de 250px, chip pegado a la izquierda)
    // el menú se abría 130px fuera de pantalla y se veía cortado ("pprove" en vez de "Approve").
    const anchoMenu = menu.offsetWidth;
    const margen = 8;
    let left = r.right - anchoMenu;
    if (left < margen) left = margen;
    if (left + anchoMenu > window.innerWidth - margen) left = Math.max(margen, window.innerWidth - margen - anchoMenu);
    menu.style.left = Math.round(left) + 'px';
    menu.style.right = 'auto';
    // Con teclado, el foco entra al menu (sin scrollear la pagina).
    if (inputByKeyboard) {
      const first = menuItems(menu)[0];
      if (first) first.focus({ preventScroll: true });
    }
    if (menuTrigger) menuTrigger.setAttribute('aria-haspopup', 'menu');
    menuOpenedAt = Date.now();
  }
  let menuOpenedAt = 0;
  const closeMenus = () => {
    closeFlys();
    clearTimeout(flyTimer);
    document.querySelectorAll<HTMLElement>('.menu').forEach((m) => { m.hidden = true; });
    document.querySelectorAll<HTMLElement>('[aria-expanded="true"][aria-haspopup="menu"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    menuTrigger = null;
  };
  // Modalidad del ultimo input: solo movemos el foco adentro del menu cuando se
  // abrio con teclado, para no robarle el foco al composer con el mouse.
  let inputByKeyboard = false;
  window.addEventListener('keydown', () => { inputByKeyboard = true; }, true);
  window.addEventListener('pointerdown', () => { inputByKeyboard = false; }, true);
  document.addEventListener('click', closeMenus);
  window.addEventListener('resize', closeMenus);
  window.addEventListener(
    'scroll',
    (e) => {
      if (e.target && (e.target as Element).closest && (e.target as Element).closest('.menu')) return; // scrollear dentro del menú no lo cierra
      // Ni el scroll automático que dispara el propio click (scrollIntoView del navegador):
      // si no, el menú de fila se cierra solo antes de poder tocarlo.
      if (Date.now() - menuOpenedAt < 500) return;
      closeMenus();
    },
    true
  );

  // Atajo de prueba para los gates del chip: un probe puede reemplazar esto y ver el orden
  // exacto de las llamadas (modelo -> esfuerzo) sin tocar el server.
  let aplicarConfig: (id: string, value: string) => any = (id, value) => setConfig(id, value);

  async function setConfig(configId, value) {
    // Regla: open_design y opencode_go solo con deepseek-v4.1-flash.
    if (configId === 'model') {
      const fijo = FIXED_MODELS[providerNow()];
      if (fijo && value && value !== fijo) {
        systemNote('Con ' + providerNow() + ' el modelo es fijo: ' + fijo + '.');
        renderChips();
        return false;
      }
    }
    if (!state.current) {
      // Todavia no hay chat: se recuerda la eleccion y se aplica al crear uno nuevo.
      state.pendingConfig = state.pendingConfig || {};
      state.pendingConfig[configId] = value;
      guardarPendientes();
      const cache = leerCacheChips();
      const opt = cache.find((o) => o && o.id === configId);
      if (opt) { opt.currentValue = value; guardarCacheChips(cache); }
      // The cached models belong to the previously selected provider. Keep its model choice
      // out of the new session: the server will offer the new provider's real model list.
      if (configId === 'provider') {
        delete state.pendingConfig.model;
        guardarPendientes();
        const model = cache.find((o) => o && o.id === 'model');
        if (model) { model.options = []; model.currentValue = ''; }
        guardarCacheChips(cache);
      }
      renderChips();
      return;
    }
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
    syncSendState();
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

  const loadImg = (src: string): Promise<HTMLImageElement> =>
    new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = src;
    });

  async function fileToAttachment(file) {
    if (!/^image\//.test(file.type || '')) return null;
    if (file.size > MAX_IMAGE) { systemNote('Imagen demasiado grande (máx 12 MB).'); return null; }
    const dataUrl = await new Promise<string>((res, rej) => {
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
      const res = await rpc.request('_aegis/unstable/slash-commands/list', {
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
  const baseName = (p) => {
    const s = String(p == null ? '' : p).replace(/[\\/]+$/, '');
    const parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || s;
  };
  // El header dice en que carpeta trabaja el chat (cwd de la sesion): en un
  // harness que edita archivos, "donde estoy" es la pregunta mas frecuente.
  function updateTitle() {
    $('#chat-title').textContent = (state.current && state.current.title) || 'Nuevo chat';
    $('#chat-title').title = ($('#chat-title').textContent || '') + (state.current && state.current.id ? ' · ' + state.current.id : '');
    // Cambiar de conversacion cierra el panel de informacion de la anterior.
    if (chatInfoOpen()) setChatInfo(false);
    const sub = $('#chat-sub');
    if (sub) {
      const cwd = (state.current && state.current.cwd) || CFG.cwd || '';
      sub.textContent = cwd ? baseName(cwd) : '';
      sub.title = cwd;
      sub.hidden = !cwd;
    }
    document.title = ((state.current && state.current.title) || 'Aegis') + ' · Aegis web';
  }
  function setStatus(kind, text) {
    const dot = $('#conn-dot');
    dot.className = 'dot' + (kind ? ' ' + kind : '');
    $('#conn-text').textContent = text;
    // Cambios de conexion: se anuncian una sola vez por texto nuevo.
    const sr = $('#sr-status');
    if (sr && sr.textContent !== text) sr.textContent = text;
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
  // El boton de enviar refleja si hay algo para mandar (texto o adjuntos): antes
  // quedaba siempre encendido y el click no hacia nada.
  function syncSendState() {
    const b = document.getElementById('btn-send') as HTMLButtonElement | null;
    const i = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!b || !i) return;
    const has = !!i.value.trim() || (Array.isArray(state.attachments) && state.attachments.length > 0);
    b.disabled = !has;
    b.setAttribute('aria-disabled', has ? 'false' : 'true');
  }
  function autosize(force?) {
    syncSendState();
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

  // Persistent chat-only type scale. Reject corrupt/out-of-range storage values.
  const CHAT_FONT_KEY = 'aegis.chatFontPx';
  const CHAT_FONT_DEFAULT = 16;
  function validChatFont(raw: string | null) {
    if (raw === null || !/^(?:[2-9]|1[0-9]|2[0-2])$/.test(raw)) return CHAT_FONT_DEFAULT;
    return Number(raw);
  }
  let chatFont = CHAT_FONT_DEFAULT;
  try { chatFont = validChatFont(localStorage.getItem(CHAT_FONT_KEY)); } catch {}
  function setChatFont(px: number) {
    chatFont = Math.max(2, Math.min(22, Math.round(px)));
    const messages = $('#messages');
    if (messages) {
      const scale = chatFont / CHAT_FONT_DEFAULT;
      messages.classList.toggle('chat-compact', chatFont <= 10);
      messages.style.setProperty('--chat-space-scale', String(Math.max(0.35, Math.min(1.25, scale))));
      const sizes: Record<string, number> = {
        '--chat-font': chatFont,
        '--chat-user-font': 14.5 * scale,
        '--chat-small-font': 12.5 * scale,
        '--chat-h3-font': 18 * scale,
        '--chat-h4-font': 16.5 * scale,
        '--chat-h5-font': 15 * scale,
        '--chat-thought-font': 13.5 * scale,
        '--chat-table-label-font': 11 * scale,
        '--chat-tool-output-font': 11.5 * scale,
        '--chat-tool-name-font': 12 * scale,
        '--chat-permission-font': 13.5 * scale
      };
      for (const [name, size] of Object.entries(sizes)) messages.style.setProperty(name, size + 'px');
    }
    const range = $('#chat-font-range') as HTMLInputElement | null;
    if (range) range.value = String(chatFont);
    const value = $('#chat-font-value');
    if (value) value.textContent = chatFont + ' px';
    try { localStorage.setItem(CHAT_FONT_KEY, String(chatFont)); } catch {}
  }
  // ---- densidad y presentación ----------------------------------------------
  // Tres densidades del transcript. No son "temas": cambian MEDIDAS del texto (medida,
  // interlinea, aire entre turnos), no colores, asi que no compiten con el sistema visual.
  //   comoda    -> lo de siempre (760px, 1.7)
  //   compacta  -> mas conversacion en pantalla (880px, 1.55, menos aire)
  //   lectura   -> una sola columna ancha de prosa (660px, 1.85, mas aire)
  // El tamano de letra sigue mandando por "Aa"; esto mueve el resto.
  const DENS_KEY = 'aegis.density';
  const DENSITIES = ['comoda', 'compacta', 'lectura'] as const;
  type Density = typeof DENSITIES[number];
  const DENS_LABEL: Record<Density, string> = { comoda: 'Cómoda', compacta: 'Compacta', lectura: 'Lectura' };
  function densValid(raw: string | null): Density {
    return (DENSITIES as readonly string[]).includes(String(raw)) ? (raw as Density) : 'comoda';
  }
  let density: Density = 'comoda';
  try { density = densValid(localStorage.getItem(DENS_KEY)); } catch {}
  function setDensity(next: Density, announce?: boolean) {
    density = densValid(next);
    const messages = $('#messages');
    if (messages) messages.dataset.density = density;
    document.documentElement.dataset.density = density;
    const btn = $('#btn-density');
    if (btn) {
      btn.setAttribute('aria-label', 'Densidad del chat: ' + DENS_LABEL[density]);
      btn.title = 'Densidad del chat: ' + DENS_LABEL[density] + ' (click para cambiar)';
      btn.dataset.density = density;
    }
    try { localStorage.setItem(DENS_KEY, density); } catch {}
    if (announce) toast('Densidad: ' + DENS_LABEL[density]);
    scrollBottom(true);
    return density;
  }
  function cycleDensity() {
    const i = DENSITIES.indexOf(density);
    return setDensity(DENSITIES[(i + 1) % DENSITIES.length], true);
  }

  // Modo presentación: oculta TODO el cromo (barra de sesiones, topbar, composer, meta) y
  // deja solo el transcript a pantalla completa, con aire. Sale con Esc o con el mismo
  // atajo. No se persiste: es una vista, no una preferencia.
  function presentationOn() { return document.documentElement.classList.contains('presentation'); }
  function setPresentation(on: boolean) {
    document.documentElement.classList.toggle('presentation', on);
    const btn = $('#btn-present');
    if (btn) btn.setAttribute('aria-pressed', String(on));
    if (on) {
      const inner = $('#msg-inner');
      inner?.scrollIntoView({ block: 'start' });
      toast('Modo presentación: Esc para salir');
    }
    return on;
  }

  function wireChatFont() {
    setChatFont(chatFont);
    const pop = $('#chat-font-pop');
    const button = $('#btn-chat-font');
    button.addEventListener('click', () => {
      pop.hidden = !pop.hidden;
      button.setAttribute('aria-expanded', String(!pop.hidden));
    });
    ($('#chat-font-range') as HTMLInputElement).addEventListener('input', (e) => setChatFont(Number((e.target as HTMLInputElement).value)));
    $('#chat-font-minus').addEventListener('click', () => setChatFont(chatFont - 1));
    $('#chat-font-plus').addEventListener('click', () => setChatFont(chatFont + 1));
    $('#chat-font-reset').addEventListener('click', () => setChatFont(CHAT_FONT_DEFAULT));
    document.addEventListener('pointerdown', (e) => {
      if (!pop.hidden && !pop.contains(e.target as Node) && !button.contains(e.target as Node)) {
        pop.hidden = true; button.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pop.hidden) { pop.hidden = true; button.setAttribute('aria-expanded', 'false'); button.focus(); }
    });
  }

  // Atajos de vista: Ctrl+Alt+P presentación, Ctrl+Alt+U banda de lo oculto al modelo.
  // (Ctrl+Alt+H ya es el handoff y Ctrl+Alt+O la galería de artefactos.)
  // Contraste: la app se usa con filtro de luz azul y sol de frente. Hay dos niveles
  // (normal / alto) que son un juego de tokens en CSS: aca solo se prende la clase.
  const CONTRAST_KEY = 'aegis.contrast';
  function setContrast(v: string) {
    const alto = v === 'alto';
    document.documentElement.setAttribute('data-contrast', alto ? 'alto' : 'normal');
    try { localStorage.setItem(CONTRAST_KEY, alto ? 'alto' : 'normal'); } catch {}
    const b = $('#btn-contrast');
    if (b) {
      b.setAttribute('aria-pressed', String(alto));
      b.title = alto ? 'Contraste alto activo (click para volver)' : 'Contraste alto: mas legible al sol y con filtros de vista (Ctrl+Alt+C)';
    }
  }
  function contrastNow() { return document.documentElement.getAttribute('data-contrast') === 'alto' ? 'alto' : 'normal'; }

  // Movimiento: ademas de prefers-reduced-motion hay un interruptor propio, porque hay quien
  // quiere el sistema con animaciones y esta app quieta (o al reves). Se guarda por navegador.
  const MOTION_KEY = 'aegis.motion';
  function setMotion(v: string) {
    const reducido = v === 'reducido';
    document.documentElement.setAttribute('data-motion', reducido ? 'reducido' : 'normal');
    try { localStorage.setItem(MOTION_KEY, reducido ? 'reducido' : 'normal'); } catch {}
  }
  function motionNow() { return document.documentElement.getAttribute('data-motion') === 'reducido' ? 'reducido' : 'normal'; }
  function cycleMotion() {
    const nuevo = motionNow() === 'reducido' ? 'normal' : 'reducido';
    setMotion(nuevo);
    toast(nuevo === 'reducido' ? 'Animaciones apagadas.' : 'Animaciones encendidas.');
  }
  function cycleContrast() {
    const nuevo = contrastNow() === 'alto' ? 'normal' : 'alto';
    setContrast(nuevo);
    toast(nuevo === 'alto' ? 'Contraste alto: texto y bordes mas fuertes.' : 'Contraste normal.');
  }

  function wireView() {
    // Orden: lo guardado manda; si no hay nada guardado y el sistema pide mas contraste, se usa.
    let guardado = '';
    try { guardado = localStorage.getItem(CONTRAST_KEY) || ''; } catch {}
    let motionGuardado = '';
    try { motionGuardado = localStorage.getItem(MOTION_KEY) || ''; } catch {}
    setMotion(motionGuardado || (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reducido' : 'normal'));
    const sistema = window.matchMedia && window.matchMedia('(prefers-contrast: more)').matches;
    setContrast(guardado || (sistema ? 'alto' : 'normal'));
    const cb = $('#btn-contrast');
    if (cb) cb.addEventListener('click', () => cycleContrast());
    setDensity(density);
    const db = $('#btn-density');
    if (db) db.addEventListener('click', () => cycleDensity());
    const pb = $('#btn-present');
    if (pb) pb.addEventListener('click', () => setPresentation(!presentationOn()));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && presentationOn()) { e.preventDefault(); setPresentation(false); return; }
      if (!(e.altKey && e.ctrlKey)) return;
      const k = String(e.key || '').toLowerCase();
      if (k === 'p') { e.preventDefault(); setPresentation(!presentationOn()); }
      else if (k === 'u') { e.preventDefault(); toggleHiddenBand(); }
      else if (k === 'c') { e.preventDefault(); cycleContrast(); }
      else if (k === 'm') { e.preventDefault(); cycleMotion(); }
    });
  }

  function wire() {
    wireChatFont();
    wireView();
    wireAccionesGlobales();
    // Info de la conversacion: abre con click/teclado, cierra con Esc o click afuera y
    // devuelve el foco al titulo.
    const infoBtn = $('#btn-chat-info');
    const infoPop = $('#chat-info');
    if (infoBtn && infoPop) {
      infoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setChatInfo(!chatInfoOpen());
      });
      $('#ci-close').addEventListener('click', () => { setChatInfo(false); infoBtn.focus({ preventScroll: true }); });
      document.addEventListener('pointerdown', (e) => {
        if (!chatInfoOpen()) return;
        if (infoPop.contains(e.target as Node) || infoBtn.contains(e.target as Node)) return;
        setChatInfo(false);
      });
      infoPop.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); setChatInfo(false); infoBtn.focus({ preventScroll: true }); }
      });
    }
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
      const th = e.target.closest('.thought');
      if (th) { th.classList.toggle('open'); return; }
      const tool = e.target.closest('.tool.has-content');
      if (tool) tool.classList.toggle('open');
    });

    $('#btn-new').addEventListener('click', () => openWorkspacePicker()); // selector de carpeta (2026-10-26)
    // Confirmaciones sin responder del store: se leen al arrancar y cada 5 minutos.
    cargarPendientes().catch(() => {});
    setInterval(() => { cargarPendientes().catch(() => {}); }, 300000);
    const wsPop = $('#ws-picker');
    if (wsPop) {
      wsPop.addEventListener('click', (e: any) => {
        const row = e.target && e.target.closest ? e.target.closest('.ws-row') : null;
        if (!row) return;
        const nav = row.getAttribute('data-nav');
        if (nav !== null) {
          wsBrowse(nav || '');
          return;
        }
        startSessionIn(row.getAttribute('data-ws') || '');
      });
      const wsCancel = $('#ws-cancel');
      if (wsCancel) wsCancel.addEventListener('click', closeWorkspacePicker);
      const wsGo = $('#ws-go');
      if (wsGo) wsGo.addEventListener('click', () => {
        const el = $('#ws-input') as HTMLInputElement | null;
        startSessionIn((el && el.value ? el.value : '').trim());
      });
      const wsInput = $('#ws-input') as HTMLInputElement | null;
      if (wsInput) wsInput.addEventListener('keydown', (e: any) => {
        if (e.key === 'Enter') { e.preventDefault(); startSessionIn(wsInput.value.trim()); }
      });
      document.addEventListener('keydown', (e: any) => {
        if (e.key === 'Escape' && !(wsPop as HTMLElement).hidden) { e.stopPropagation(); closeWorkspacePicker(); }
      }, true);
    }
    // con turno en curso: detachRunView adentro (el run sigue en el server)
    $('#btn-menu').addEventListener('click', openDrawer);
    $('#overlay').addEventListener('click', closeDrawer);
    $('#btn-close-drawer').addEventListener('click', closeDrawer);
    $('#btn-send').addEventListener('click', send);
    $('#btn-stop').addEventListener('click', stopRun);
    // Lectura en voz alta: el boton y el corte al enviar/detener (las funciones estan hoisted).
    const rb = $('#btn-read');
    if (rb) rb.addEventListener('click', () => readToggle());
    const corta = () => readReset(true);
    $('#btn-send').addEventListener('click', corta);
    $('#btn-stop').addEventListener('click', corta);
    readSyncBtn();

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

    $('#search').addEventListener('input', (e) => { state.filter = e.target.value; renderList(); scheduleRemoteSearch(); });
    // Teclado en la lista: flechas recorren las sesiones, Home/End van a los extremos.
    // Con 300+ sesiones, tabular fila por fila no es una opcion.
    $('#session-list').addEventListener('keydown', (e) => {
      const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      const items = [...document.querySelectorAll<HTMLElement>('#session-list .sb-item')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      let next = i;
      if (e.key === 'ArrowDown') next = i < 0 ? 0 : Math.min(items.length - 1, i + 1);
      else if (e.key === 'ArrowUp') next = i < 0 ? items.length - 1 : Math.max(0, i - 1);
      else if (e.key === 'Home') next = 0;
      else next = items.length - 1;
      e.preventDefault();
      items[next].focus();
    });
    $('#search').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        const first = document.querySelector<HTMLElement>('#session-list .sb-item');
        if (first) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.key === 'Escape' && $('#search').value) {
        e.preventDefault();
        e.stopPropagation();
        $('#search').value = '';
        state.filter = '';
        renderList();
        resetRemote();
      }
    });
    $('#slash-menu').addEventListener('click', (e) => {
      const it = e.target.closest('.slash-item');
      if (!it) return;
      insertSlash(state.slashItems[Number(it.dataset.i)]);
    });
    $('#session-list').addEventListener('click', (e) => {
      const mas = e.target.closest('.sb-more-results');
      if (mas) {
        e.stopPropagation();
        if (state.remote && state.remote.q) void runRemoteSearch(state.remote.q, 50);
        return;
      }
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
      if (state.current && state.current.id === id) { closeDrawer(); return; }
      if (entry) { openSession(entry); return; }
      // Coincidencia en el contenido de una sesion que no esta en la pagina cargada: se abre
      // con lo minimo que devuelve el indice (id, titulo, cwd) y session/load trae el resto.
      const remoto = (state.remote.sessions || []).find((s) => s.sessionId === id);
      if (remoto) openSession({ sessionId: id, title: remoto.title, cwd: remoto.cwd } as any);
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
      // Nuevo chat desde el teclado (el title del boton lo anuncia).
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && String(e.key).toLowerCase() === 'o') {
        e.preventDefault();
        newSession();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        const sb = $('#sidebar');
        if (window.innerWidth <= 880 && !sb.classList.contains('open')) openDrawer();
        $('#search').focus(); $('#search').select();
      }
    });

    window.addEventListener('resize', autosize);
    wireDropzone();
    syncSendState(); // estado inicial (borrador guardado o vacio)
  }

  // Superficie de depuración (LAN, un solo usuario): inspeccionar estado desde la consola
  // y desde los checks automatizados. No expone secretos (el WS ya vive en /config.js).
  // --- Lectura en voz alta (TTS) del bloque "Para escuchar" -------------------------------
  // Reglas: se lee SOLO el bloque que abre con un encabezado tipo "## Para escuchar" (o "Para leer",
  // "Lectura en voz alta"). Se lee EN VIVO: frase por frase, mientras el texto todavia llega por el
  // stream. Nada de afuera del bloque se lee. Y todo esto pasa solo si el modo esta encendido.
  var READ_ON = false;
  // El modo de lectura es POR CHAT: cada chat recuerda si lo tiene encendido y al abrirlo se aplica
  // (y se corta el audio del chat anterior). Clave: aegis.readOn.<sid>; 'nuevo' mientras no hay sesion.
  function readKeyFor(id) { return 'aegis.readOn.' + (id || 'nuevo'); }
  function readLoad() {
    readReset(true);   // cambiar de chat corta lo que estuviera sonando
    try {
      var id = state.current && state.current.id;
      var v = localStorage.getItem(readKeyFor(id));
      if (v === null) {
        var viejo = localStorage.getItem('aegis.readOn');   // migracion del interruptor global viejo
        if (viejo !== null) { v = viejo === '1' ? '1' : '0'; localStorage.setItem(readKeyFor(id), v); localStorage.removeItem('aegis.readOn'); }
        else { v = '0'; }
      }
      READ_ON = v === '1';
    } catch (e) { READ_ON = false; }
    readSyncBtn();
    return READ_ON;
  }
  try { READ_ON = localStorage.getItem(readKeyFor(null)) === '1'; } catch (e) {}
  // 1.365 = 30% mas rapido que el 1.05 que usaba el server. Se puede cambiar sin rebuild:
  // localStorage['aegis.ttsRate'] = '1.4'.
  var READ_RATE = (function () { try { var v = Number(localStorage.getItem('aegis.ttsRate')); return v > 0.5 && v < 2 ? v : 1.365; } catch (e) { return 1.365; } })();
  var READ: Record<string, any> = { key: null, consumed: 0, spoken: 0, rate: READ_RATE, voice: null, engine: 'piper', voiceName: 'es_AR-daniela-high', fallos: 0 };
  // Solo Piper (local). Se borra cualquier motor/voz guardados de antes (edge y groq quedaron sin
  // servicio) para no seguir mandando una voz que Piper no tiene en cada pedido.
  try {
    if (localStorage.getItem('aegis.ttsEngine') !== 'piper') localStorage.removeItem('aegis.ttsEngine');
    localStorage.removeItem('aegis.ttsVoice');
  } catch (e) {}

  function readVoicePick() {
    try {
      var vs = window.speechSynthesis.getVoices() || [];
      if (!vs.length) return;
      var es = vs.filter(function (v) { return /^es/i.test(v.lang || ''); });
      READ.voice = es[0] || vs[0] || null;
    } catch (e) {}
  }
  // Motor del server (Piper, voces neuronales locales) con cola de audio: una frase a la vez,
  // y si algo falla cae a la voz del dispositivo en vez de quedarse mudo.
  var AUD = { q: [], playing: false, cur: null, pre: null };
  // Se pide YA la frase siguiente mientras suena la actual: Piper tarda ~1 s por frase (casi todo es
  // arrancar el proceso) y ese tiempo queda escondido detras del audio que ya esta sonando: antes cada
  // punto y aparte se notaba como una pausa.
  function audPrefetch() {
    if (AUD.pre || !AUD.q.length) return;
    var t = AUD.q[0];
    var a = new Audio(ttsUrlFor(READ.voiceName, t, READ.rate));
    a.preload = 'auto';
    try { a.load(); } catch (e) {}
    AUD.pre = { t: t, a: a };
  }
  function audNext() {
    if (AUD.playing || !AUD.q.length) return;
    var t = AUD.q[0];
    var a = (AUD.pre && AUD.pre.t === t) ? AUD.pre.a : null;
    AUD.pre = null;
    AUD.q.shift();
    AUD.playing = true;
    a = a || new Audio(ttsUrlFor(READ.voiceName, t, READ.rate));
    AUD.cur = a;
    var segir = function () { AUD.playing = false; AUD.cur = null; audNext(); if (!AUD.playing && !AUD.q.length) handsFreeMaybe(); };
    // Sin caida a la voz del dispositivo (a pedido: la del telefono suena mal). Si el server no
    // responde, esta frase se saltea y avisa, en vez de sonar con la voz vieja.
    var fallar = function () {
      if (AUD.cur === a) { AUD.playing = false; AUD.cur = null; }
      READ.fallos = (READ.fallos || 0) + 1;
      try { console.warn('lectura: fallo el audio de Piper (intento ' + READ.fallos + ')'); } catch (e) {}
      if (READ.fallos === 1) systemNote('No pude pedirle el audio al server (¿está encendido?). Sigo mudo: la voz del teléfono quedó desactivada.');
      audNext();
    };
    a.onended = segir;
    a.onerror = fallar;
    var pr = a.play();
    if (pr && pr.catch) pr.catch(fallar);
    // Barge-in: mientras suena la voz, el micro queda escuchando para poder interrumpir.
    // No depende del modo manos libres: alcanza con que la lectura este encendida. Si ya hay
    // una toma abierta se la marca como barge; si no, se abre una (con permiso ya dado).
    if (READ_ON && document.visibilityState === 'visible') {
      if (MIC.rec) { MIC.barge = true; MIC.bargeHits = 0; }
      else if (!MIC.denied) {
        if (!MIC.bargeLog) { MIC.bargeLog = true; report('barge', 'abro el micro para interrumpir (granted=' + !!MIC.granted + ')'); }
        micStart({ auto: true, barge: true });
      }
    }
    audPrefetch();   // deja lista la frase siguiente
  }
  function audStop() {
    AUD.q.length = 0;
    if (AUD.cur) { try { AUD.cur.pause(); } catch (e) {} AUD.cur = null; }
    AUD.pre = null;
    AUD.playing = false;
  }
  // Se borro el camino de la voz del dispositivo (speechSynthesis): solo Piper.
  function readSay(text) {
    var t = String(text || '').trim();
    if (!t) return;
    var btn = document.getElementById('btn-read');
    if (btn) btn.classList.add('speaking');
    AUD.q.push(t);
    audNext();
    // Si ya hay algo sonando, este trozo quedo esperando: se sintetiza YA (Piper tarda ~1 s) para que
    // al terminar el anterior arranque sin pausa. Antes la precarga salia solo si el trozo ya estaba
    // encolado cuando arrancaba el anterior, que en el uso real casi nunca pasa.
    audPrefetch();
  }
  function readReset(cancelar) {
    audStop();
    READ.spoken = 0; READ.key = null;
    try { if (cancelar && window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
    var btn = document.getElementById('btn-read');
    if (btn) btn.classList.remove('speaking');
  }
  // se llama en cada chunk del stream con el texto crudo acumulado del mensaje
  // final=true (fin del turno): habla tambien lo que quedo sin punto final.
  function readPump(key, rawText, final?) {
    if (!READ_ON) return;
    // El plan no se narra: ni el turno artificial de cierre ni lo que sigue al marcador.
    if (DEBATE && DEBATE.closing) return;
    if (/plan final/i.test(String(rawText || ''))) { audStop(); return; }
    if (READ.key !== key) { READ.key = key; READ.consumed = 0; }  // mensaje nuevo: arranca de cero
    READ.lastKey = key; READ.lastRaw = rawText;
    // El avance se mide sobre el TEXTO CRUDO del bloque, no sobre el limpio: el limpio cambia
    // retroactivamente mientras llega markdown a medias (un ` sin cerrar, un [link](url sin
    // terminar), y ahi los offsets se corrian y se hablaban pedazos ("ta y codigo.").
    var raw = readBlock(rawText);
    if (!raw) {
      // Sin bloque "Para escuchar": en manos libres se lee la respuesta completa (el debate no
      // trae ese encabezado). Fuera de manos libres, solo prosa corta y sin codigo.
      var texto = String(rawText || '');
      if (HF && HF.on) raw = texto;
      else if (READ_ON && texto.indexOf('```') < 0 && texto.length <= 1200) raw = texto;
    }
    if (!raw) return;
    var done = READ.consumed || 0;
    if (raw.length <= done) return;
    var pend = raw.slice(done);
    // Corte de trozo: se agrupan oraciones hasta ~260 caracteres (menos pedidos y menos pausas:
    // cada pedido cuesta ~1 s de arranque de Piper). El PRIMER trozo sale apenas hay una oracion
    // completa, para que la voz arranque enseguida.
    var cortes = [], mm;
    var reCut = /[.!?…](?=\s|$)/g;
    while ((mm = reCut.exec(pend))) cortes.push(mm.index + 1);
    // 900 chars por trozo y se prefiere el corte de parrafo: cada corte es una sintesis
    // separada y eso se oye como una pausa larga entre oraciones.
    var LIMITE = 900;
    var parrafo = pend.indexOf('\n\n');
    var cut = -1;
    if (done === 0) {
      // Arranque rapido: la voz empieza con la primera coma (o ~90 chars) en vez de esperar
      // a que se complete la primera oracion entera. El resto sigue agrupado por parrafo.
      var coma = pend.search(/[,;:]\s/);
      if (coma > 24) cut = coma + 2;
      else if (parrafo > 0 && parrafo + 2 <= LIMITE) cut = parrafo + 2;
      else if (cortes.length) cut = cortes[0];
      else if (pend.length >= 90 && pend.indexOf(' ') > 0) cut = pend.lastIndexOf(' ');
    }
    if (cut < 0) {
      for (var i = 0; i < cortes.length; i++) if (cortes[i] <= LIMITE) cut = cortes[i];
      if (parrafo > 0 && parrafo + 2 <= LIMITE && parrafo + 2 > cut) cut = parrafo + 2;
      if (cut < 0) {
        if (cortes.length) cut = cortes[0];                      // oracion larguisima: corta igual
        else if (final) cut = pend.length;                       // cierre de turno: lo que haya
        else if (pend.length > LIMITE + 60 && pend.indexOf(' ') > 0) cut = pend.lastIndexOf(' ');
        else return;                                             // poco texto todavia: espera mas
      }
    }
    var trozo = readClean(pend.slice(0, cut));
    READ.consumed = done + cut;
    if (trozo.length > 2) readSay(trozo);
  }
  // cierre del turno: habla el resto del bloque (texto sin punto final, etc.)
  function readFlush() {
    if (!READ_ON || !READ.lastKey) return;
    readPump(READ.lastKey, READ.lastRaw || '', true);
  }
  function readToggle(force?) {
    READ_ON = (force === undefined) ? !READ_ON : !!force;
    // El click es el gesto que permite pedir el microfono: se pide ahora para poder
    // interrumpir la voz despues (sin gesto el permiso queda pendiente y nunca se abre).
    if (READ_ON && !MIC.rec && !MIC.denied && micSecure()) micStart({ auto: true, barge: true });
    try { localStorage.setItem(readKeyFor(state.current && state.current.id), READ_ON ? '1' : '0'); } catch (e) {}
    var btn = document.getElementById('btn-read');
    if (btn) {
      btn.classList.toggle('on', READ_ON);
      btn.title = READ_ON
        ? 'Lectura en voz alta ENCENDIDA: se lee el bloque «Para escuchar» en vivo. Tocá para apagar.'
        : 'Leer en voz alta: lee SOLO el bloque «Para escuchar» de cada respuesta, en vivo mientras llega';
    }
    if (!READ_ON) readReset(true);
    else { readVoicePick(); readReset(true); }
    readSyncBtn();
    systemNote(READ_ON ? 'Lectura en voz alta encendida.' : 'Lectura en voz alta apagada.');
    return READ_ON;
  }
  function readSyncBtn() {
    var b = document.getElementById('btn-read');
    if (!b) return false;
    b.classList.toggle('on', READ_ON);
    b.setAttribute('aria-pressed', READ_ON ? 'true' : 'false');
    b.title = READ_ON
      ? 'Lectura en voz alta ENCENDIDA: se lee el bloque «Para escuchar» en vivo. Tocá para apagar.'
      : 'Leer en voz alta: lee SOLO el bloque «Para escuchar» de cada respuesta, en vivo mientras llega';
    if (READ_ON) readVoicePick();
    try { if (window.speechSynthesis) window.speechSynthesis.addEventListener('voiceschanged', readVoicePick); } catch (e) {}
    return true;
  }
  if (!readSyncBtn()) document.addEventListener('DOMContentLoaded', readSyncBtn, { once: true });

  // --- Borrador por chat -------------------------------------------------------------------
  // Lo que escribis y aun no mandaste queda guardado SOLO para ese chat: si cambias de chat o
  // recargas la pagina, sigue ahi. Al enviar, se limpia.
  var draftTimer = 0;
  var lastListPoll = 0;
  function draftKey(id) { return 'aegis.draft.' + (id || 'nuevo'); }
  function saveDraft() {
    try {
      var el = document.getElementById('input') as HTMLTextAreaElement | null;
      if (!el) return;
      var k = draftKey(state.current && state.current.id);
      if (el.value && el.value.trim()) localStorage.setItem(k, el.value);
      else localStorage.removeItem(k);
    } catch (e) {}
  }
  function loadDraft() {
    try {
      var el = document.getElementById('input') as HTMLTextAreaElement | null;
      if (!el) return;
      el.value = localStorage.getItem(draftKey(state.current && state.current.id)) || '';
      autosize(); refreshSlashMenu();
    } catch (e) {}
  }
  function wireDraft() {
    var el = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!el) return false;
    el.addEventListener('input', function () { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); });
    el.addEventListener('blur', saveDraft);
    window.addEventListener('beforeunload', saveDraft);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') saveDraft(); });
    window.addEventListener('focus', function () { try { document.title = String(document.title).replace(/^([\u2714\u2705]\s*)/, ''); } catch (e) {} });
    return true;
  }

  // --- Estado en vivo de los turnos (para la lista de chats, desde cualquier vista) ----------
  var liveRuns = new Map();   // sid -> { t0, doneT }
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
        var s = (state.sessions || []).filter(function (x) { return x.sessionId === sid; })[0];
        var titulo = (s && s.title) || ('chat ' + String(sid).slice(0, 8));
        systemNote('Terminó: ' + titulo + '.');
        try { document.title = '\u2714 ' + String(document.title).replace(/^\u2714\s*/, ''); } catch (e) {}
      }
    }
    try { renderList(); } catch (e) {}
  }
  function isRunning(id) {
    if (state.runningIds && state.runningIds.has(id)) return true;
    var r = liveRuns.get(id);
    return !!(r && !r.doneT);
  }
  function isDoneRecently(id) {
    var r = liveRuns.get(id);
    return !!(r && r.doneT && Date.now() - r.doneT < 90000);
  }
  function anyRunning() {
    if (state.runningIds && state.runningIds.size) return true;
    var hay = false;
    liveRuns.forEach(function (v) { if (!v.doneT) hay = true; });
    return hay;
  }

  // --- Volver a escuchar un mensaje que trae bloque "Para escuchar" -------------------------
  if (!wireDraft()) document.addEventListener('DOMContentLoaded', wireDraft, { once: true });

  // ---------- panel de objetivos (/goal y /grind, barra derecha) ----------
  // Los datos salen de /goals.json: el server web indexa una copia de sessions.db (el
  // extension_data "goal.v0" de cada sesion, completado con el ultimo /goal del historial).
  // Reanudar = abrir esa conversacion; el objetivo vive en el server, asi que volver a ella lo
  // reactiva sin crear un chat nuevo.
  async function fetchGoals(forzar) {
    // Solo los objetivos del chat que se esta viendo: es lo que se quiere tener a mano, sin
    // invade. r nada.
    const sid = (state.current && state.current.id) || '';
    if (!sid) { state.goals = []; state.goalsErr = ''; renderGoals(); return; }
    if (!forzar && state.goalsSid === sid && state.goalsAt && Date.now() - state.goalsAt < 20000) return;
    state.goalsSid = sid;
    state.goalsAt = Date.now();
    try {
      const r = await fetch('/goals.json?sid=' + encodeURIComponent(sid), { cache: 'no-store' });
      const j = await r.json();
      state.goals = Array.isArray(j.items) ? j.items : [];
      state.goalsErr = j.error || '';
      state.goalsNombre = j.nombre || '';
      // El chip del compositor se pinta con el estado REAL del servidor (extension_data "goal.v0"),
      // no con lo deducido del texto: antes el chip mostraba un objetivo que el servidor ya habia
      // vaciado. Si el usuario lo borro del panel, tampoco se muestra.
      const activo = typeof j.activo === 'string' && j.activo.trim() ? j.activo : null;
      const vigente = activo && !gpOcultoPorTexto(activo) ? activo : null;
      state.goal = vigente;
      state.grind = vigente && j.activoTipo === 'grind' ? vigente : null;
      renderGoalBar();
    } catch (e) {
      state.goals = [];
      state.goalsErr = String((e && e.message) || e);
    }
    renderGoals();
  }

  function fechaCorta(valor) {
    const d = new Date(String(valor || '').replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return String(valor || '');
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // Reactivar un objetivo viejo de ESTE chat: se re-emite el comando, que es lo que lo vuelve a
  // poner en extension_data. No es "abrir otro chat": el objetivo vive en este.
  function reactivarObjetivo(it) {
    if (!it || !it.texto) return;
    sendText('/' + (it.tipo === 'grind' ? 'grind' : 'goal') + ' ' + it.texto);
  }

  // "Borrar" en el panel = ocultarlo de la lista, reversible y sin tocar la conversacion (el
  // historial y el estado del serve quedan intactos). Para el objetivo ACTIVO, borrar de verdad es
  // otro boton: Quitar, que manda /goal off y lo saca del extension_data.
  function gpClave(it) {
    return [it.sid || '', it.cuando || it.actualizado || '', String(it.texto || '').slice(0, 60)].join('|');
  }

  function gpOcultos() {
    try {
      const j = JSON.parse(localStorage.getItem('aegis.goalsOcultos') || '[]');
      return Array.isArray(j) ? j : [];
    } catch (e) { return []; }
  }

  function gpOcultoEsta(it) { return gpOcultos().indexOf(gpClave(it)) !== -1; }

  // Lo mismo pero por texto: el chip del compositor solo tiene el texto del objetivo, no su fecha.
  function gpOcultoPorTexto(texto) {
    const sid = (state.current && state.current.id) || '';
    const buscado = String(texto || '').slice(0, 60);
    if (!buscado) return false;
    return gpOcultos().some((clave) => {
      const partes = String(clave).split('|');
      return partes[2] === buscado && (!sid || !partes[0] || partes[0] === sid);
    });
  }

  function gpOcultar(it) {
    const l = gpOcultos();
    const k = gpClave(it);
    if (l.indexOf(k) === -1) l.push(k);
    try { localStorage.setItem('aegis.goalsOcultos', JSON.stringify(l.slice(-400))); } catch (e) {}
    renderGoals();
  }

  function gpRestaurar() {
    const l = gpOcultos();
    const items = Array.isArray(state.goals) ? state.goals : [];
    const claves = items.map(gpClave);
    const quedan = l.filter((k) => claves.indexOf(k) === -1);
    try { localStorage.setItem('aegis.goalsOcultos', JSON.stringify(quedan)); } catch (e) {}
    renderGoals();
  }

  function gpItem(it) {
    const d = document.createElement('div');
    d.className = 'gp-item' + (it.activo ? ' activo' : '');
    const t = document.createElement('div');
    t.className = 'gp-text';
    t.textContent = it.texto || '(sin texto)';
    t.title = it.texto || '';
    const m = document.createElement('div');
    m.className = 'gp-meta';
    m.textContent = fechaCorta(it.cuando || it.actualizado) + (it.tipo === 'grind' ? ' · a fondo' : '');
    const fila = document.createElement('div');
    fila.className = 'gp-botones';
    // "Quitar/Reactivar" + "x" eran dos botones por objetivo. Ahora un solo disparador con las
    // dos acciones y el efecto de cada una como pista.
    fila.append(botonAcciones('objetivo', () => {
      const out: ActItem[] = [];
      if (it.activo) out.push({ label: 'Quitar del chat', hint: '/goal off', icon: uiIcon('undo', { size: 13 }), run: () => sendText('/goal off') });
      else out.push({ label: 'Reactivar', hint: 'volver a ponerlo', icon: uiIcon('spark', { size: 13 }), run: () => reactivarObjetivo(it) });
      out.push({
        label: it.activo ? 'Ocultar del panel' : 'Borrar del panel',
        hint: it.activo ? 'sigue activo en el chat' : 'no toca la conversacion',
        danger: true, icon: uiIcon('eyeOff', { size: 13 }), run: () => gpOcultar(it),
      });
      return out;
    }));
    d.append(t, m, fila);
    return d;
  }

  function renderGoals() {
    const body = document.getElementById('gp-body');
    if (!body) return;
    const todos = Array.isArray(state.goals) ? state.goals : [];
    const items = todos.filter((i) => !gpOcultoEsta(i));
    body.innerHTML = '';
    if (!(state.current && state.current.id)) {
      const v = document.createElement('div');
      v.className = 'gp-empty';
      v.textContent = 'Abri un chat para ver sus objetivos.';
      body.append(v);
      return;
    }
    if (state.goalsErr) {
      const e = document.createElement('div');
      e.className = 'gp-empty';
      e.textContent = 'No pude leer los objetivos: ' + state.goalsErr;
      body.append(e);
    }
    const seccion = (titulo, lista) => {
      const h = document.createElement('div');
      h.className = 'gp-sec';
      h.textContent = titulo + ' (' + lista.length + ')';
      body.append(h);
      if (!lista.length) {
        const v = document.createElement('div');
        v.className = 'gp-empty';
        v.textContent = 'Ninguno.';
        body.append(v);
        return;
      }
      for (const it of lista) body.append(gpItem(it));
    };
    const activo = items.filter((i) => i.activo);
    const viejos = items.filter((i) => !i.activo);
    if (activo.length) seccion('En curso', activo);
    if (viejos.length) seccion(activo.length ? 'Anteriores' : 'Anteriores (ninguno activo)', viejos);
    if (!items.length && !state.goalsErr) {
      const v = document.createElement('div');
      v.className = 'gp-empty';
      v.textContent = todos.length ? 'Todos los objetivos de este chat estan borrados del panel.' : 'Este chat todavia no tiene /goal.';
      body.append(v);
    }
    const ocultos = todos.length - items.length;
    if (ocultos > 0) {
      const pie = document.createElement('div');
      pie.className = 'gp-pie';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gp-restaurar';
      b.textContent = ocultos === 1 ? 'Mostrar el borrado' : 'Mostrar los ' + ocultos + ' borrados';
      b.addEventListener('click', () => gpRestaurar());
      pie.append(b);
      body.append(pie);
    }
  }

  // Popover: no ocupa ancho ni reacomoda el chat (es flotante y arranca cerrado).
  function gpSetVisible(v) {
    const p = document.getElementById('goals');
    if (!p) return;
    p.hidden = !v;
    const btn = document.getElementById('btn-goals');
    if (btn) btn.setAttribute('aria-pressed', v ? 'true' : 'false');
    if (v) fetchGoals(true);
  }

  function gpEstaAbierto() {
    const p = document.getElementById('goals');
    return !!p && !p.hidden;
  }

  // ---------- cerrar sesion ----------
  // Solo tiene sentido cuando hay autenticacion de por medio (tunel) o cuando hay una cookie de
  // sesion emitida: ahi el boton borra la cookie y el server vuelve a pedir la contrasena.
  (function wireSalir() {
    const arrancar = () => {
      const btn = document.getElementById('btn-logout');
      if (!btn) return;
      let mostrar = false;
      try { mostrar = !!(CFG && (CFG.tunnel || CFG.authed)); } catch (e) {}
      btn.hidden = !mostrar;
      btn.addEventListener('click', () => { location.href = '/logout'; });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar, { once: true });
    else arrancar();
  })();

  (function wireGoals() {
    const arrancar = () => {
      const btn = document.getElementById('btn-goals');
      if (btn) btn.addEventListener('click', (ev) => { ev.stopPropagation(); gpSetVisible(document.getElementById('goals').hidden); });
      const ref = document.getElementById('gp-refresh');
      if (ref) ref.addEventListener('click', () => fetchGoals(true));
      // Se cierra al tocar afuera o con Escape (discreto: no queda nada ocupando la pantalla).
      document.addEventListener('click', (ev) => {
        const p = document.getElementById('goals');
        if (!p || p.hidden) return;
        // OJO: los botones del panel re-renderizan la lista, asi que para cuando este manejador
        // corre el nodo clickeado ya esta desprendido y p.contains() da false: el popover se cerraba
        // solo al borrar o reactivar. El camino del evento (composedPath) se calcula al despachar y
        // sobrevive al re-render.
        const camino = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
        const dentro = camino.some((n: any) => n && n.id && (n.id === 'goals' || n.id === 'btn-goals'));
        if (dentro) return;
        if (ev.target && (p.contains(ev.target as Node) || ((ev.target as Element).closest && (ev.target as Element).closest('#btn-goals')))) return;
        gpSetVisible(false);
      });
      document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') gpSetVisible(false); });
      // Arranca cerrado: aparece solo si lo pedis con el boton de la barra.
      setInterval(() => {
        const p = document.getElementById('goals');
        if (p && !p.hidden) fetchGoals(true);
      }, 60000);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar, { once: true });
    else arrancar();
  })();

  (window as any).__aegisWeb = { openTool, bargeLog: () => ({ rec: !!MIC.rec, barge: !!MIC.barge, granted: !!MIC.granted, denied: !!MIC.denied, playing: !!AUD.playing, hits: MIC.bargeHits || 0 }), state, setConfig: setConfig, rpc: rpc, readBlock: readBlock, readHeading: readHeading, readPump: readPump, readToggle: readToggle, markHiddenTail: markHiddenTail,
    // Vista: densidad, modo presentación y la banda de lo que el modelo no ve.
    view: {
      density: () => density, cycleDensity, setDensity, densities: () => DENSITIES.slice(),
      present: () => presentationOn(), setPresent: setPresentation,
      toggleHiddenBand, hiddenBand: () => document.querySelector('#msg-inner .rw-band'),
      phase: () => ({ name: PHASE.name, since: PHASE.since }), setPhase: phaseSet,
      contrast: () => contrastNow(), setContrast: (v: string) => setContrast(v), cycleContrast,
    },
    // Iconos: las mismas funciones que usa el render, para que un gate mida el set real.
    icons: { tool: toolIconSvg, kind: toolKindOf, ui: uiIcon, names: () => Object.keys(TOOL_ICON) },
    // Menú de acciones por fila: el mismo módulo que usan las respuestas y los objetivos.
    acts: { boton: botonAcciones, abrir: abrirAcciones, cerrar: cerrarAcciones },
    // Chips: render para un gate que inyecta configOptions, y el estado vivo del esfuerzo.
    chips: { render: renderChips, effortNow: () => effortGlobal, options: () => effortOptions.map((o) => o.value), memo: effortByModel,
      // Un probe reemplaza el aplicador para medir el orden de las llamadas sin red.
      setAplicar: (fn) => { aplicarConfig = typeof fn === 'function' ? fn : ((id, v) => setConfig(id, v)); } },
    bargeNow: function () { return { rec: !!MIC.rec, barge: !!MIC.barge, playing: !!AUD.playing, hits: MIC.bargeHits || 0 }; },
    micOff: function () { micStop(true); },   // solo para el probe de barge-in
    setRate: function (v) { var n = Number(v); if (n > 0.5 && n < 2) { READ.rate = n; try { localStorage.setItem('aegis.ttsRate', String(n)); } catch (e) {} readReset(true); return n; } return READ.rate; },
    goalFromText: goalFromText, gpOcultoPorTexto: gpOcultoPorTexto, noteGoalFrom: noteGoalFrom, fetchGoals: fetchGoals, renderGoals: renderGoals, goalsNow: function () { return state.goals; }, gpSetVisible: gpSetVisible, goalNow: function () { return state.goal; }, renderGoalBar: renderGoalBar, copyId: copySessionId, avisoVacio: avisoTurnoVacio, chunksTurn: () => chunksTurn, renderUsagePublic: renderUsage, metaRight: () => $('#meta-right'), usageDbg: () => state.usageDbg, usageState: () => state.usage, usageLines: () => usageLines(), usageReset: resetUsageForSession, md: (t) => md(t), read: { on: () => READ_ON, toggle: readToggle, pump: readPump, flush: readFlush, reset: readReset,
    live: { mark: markRun, running: isRunning, done: isDoneRecently, any: anyRunning },
    perChat: { load: readLoad, key: readKeyFor, now: () => READ_ON },
    append: (t) => streamAppend('test-msg', t, false, false),
    draft: { save: saveDraft, load: loadDraft, key: draftKey },
    engine: (m, v) => { if (m) READ.engine = m; if (v) READ.voiceName = v; try { localStorage.setItem('aegis.ttsEngine', READ.engine); localStorage.setItem('aegis.ttsVoice', READ.voiceName); } catch (e) {} readReset(true); return READ.engine + '|' + READ.voiceName; }, block: (t) => readBlock(t), clean: (t) => readClean(t), state: () => READ }, drainRender, flushRender, showWelcome, refreshSessions, slashCommands: () => state.slash.slice(), dropSocket: () => { try { rpc.ws.close(); } catch {} }, probeRun: activeRunId, resync: resyncAdoptedRun, adopt: adoptRun, pendingSteers: loadPending, stopWatch: stopRunWatch, startWatch: startRunWatch, watchTick: watchAdoptedRun, softResync, sweepTools: sweepInterruptedTools, metrics: METRICS, watchDbg: WATCH_DBG, hub: () => ({ soportado: state.hubWatch, sid: state.hubWatchSid, cursor: state.hubCursor, watchers: state.hubWatchers, replay: state.hubReplay }), hubWatchNow: startHubWatch, hubRewatch, hubWatchSession: watchSession, hubUnwatch: () => (state.hubWatchSid ? hubUnwatch(state.hubWatchSid) : null), hubInfo: runIdFromInfo, resetMetrics: () => { METRICS.renders = 0; METRICS.renderMs = 0; METRICS.maxRenderMs = 0; METRICS.composerRuns = 0; METRICS.composerMs = 0; METRICS.maxComposerMs = 0; }, speedStart, speedFeed: speedChunk, speedFinish, speedReset, speedSummary, turnEndNote };

  if (CFG.host === 'mock') (window as any).__aegisWeb.testUi = { update: applyUpdate, usage: onAegisUpdate, rate: stepRate, pop: openUsagePop, busy: setBusy, run: applyActiveRunId, reconcile: hubOrphanTick, addUser, identifyUserBubble, steerDelivered: markSteerDelivered, seedSteer: (mid, el) => { state.steers.set(mid, { el, text: '', atts: [] }); paintQueuedRunBar(); }, watchRevision: () => liveRunRevision };

  wire();
  rpc.connect();
  report('boot', 'app cargada (v6.4+hub+detach+wd+sc)');
})();
