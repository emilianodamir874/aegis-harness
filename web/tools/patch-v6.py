# Parche v6 de C:\goose-web\app\app.js
# - adopta el turno en curso al recargar (barra + Detener + refresco periodico)
# - manda el mensaje como steer cuando el server dice que ya hay un run
# - reencola (y avisa) las indicaciones que el turno no consumio
# Anclas ASCII y assert de ocurrencia unica. CRLF preservado.
import io, sys, os

P = r'C:\goose-web\app\app.js'
raw = open(P, 'rb').read()
nl = b'\r\n' if b'\r\n' in raw else b'\n'
text = raw.decode('utf-8')
print('newline:', repr(nl), 'bytes:', len(raw))
open(P + '.bak-v6', 'wb').write(raw)

def rep(old, new, label):
    global text
    n = text.count(old)
    if n != 1:
        sys.exit('ANCLA FALLIDA [%s]: %d ocurrencias' % (label, n))
    text = text.replace(old, new, 1)
    print('ok', label)

def slice_rep(start, end, new, label):
    """Reemplaza [start, end) conservando `end`."""
    global text
    i = text.find(start)
    j = text.find(end)
    if i < 0 or j < 0 or j <= i:
        sys.exit('SLICE FALLIDA [%s]: i=%d j=%d' % (label, i, j))
    if text.count(start) != 1 or text.count(end) != 1:
        sys.exit('SLICE NO UNICA [%s]' % label)
    text = text[:i] + new + text[j:]
    print('ok', label, '(slice %d chars)' % (j - i))

# ---------- 1. estado nuevo ----------
rep("    adopted: false,",
    "    adopted: false,\n    resyncing: false,\n    suppressSettle: false,", 'estado')

# ---------- 2. errores RPC: conservar data/code ----------
rep("          if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error((m.error && m.error.message) || 'error RPC')) : p.res(m.result); }",
    """          if (p) {
            this.pending.delete(m.id);
            if (m.error) {
              // Conservamos data/code: el data de un steer trae el run activo real
              // ("actualRunId") y el de un prompt nombra el run que ya esta en curso.
              const err = new Error((m.error && m.error.message) || 'error RPC');
              err.code = m.error.code;
              err.data = m.error.data;
              p.rej(err);
            } else p.res(m.result);
          }""", 'rpc-error')

# ---------- 3. al cerrarse el WS: no reencolar indicaciones por una caida ----------
rep("""      ws.onclose = () => {
        this.ready = false;""",
    """      ws.onclose = () => {
        this.ready = false;
        state.suppressSettle = true; // caida de red != turno terminado""", 'onclose')

# ---------- 4. al reconectar: puede seguir habiendo un run vivo ----------
rep("""        } catch (e) {
          report('error', 'initialize: ' + e.message);""",
    """          checkAdoptedRun();
        } catch (e) {
          report('error', 'initialize: ' + e.message);""", 'onopen-adopta')

# ---------- 5. setQueuedNote acepta la entrada de state.steers ----------
rep("""  const setQueuedNote = (el, msg) => {
    if (!el) return;""",
    """  const setQueuedNote = (el, msg) => {
    if (el && el.el) el = el.el; // acepta {el, text, atts}
    if (!el) return;""", 'setQueuedNote')

# ---------- 6. resetTransient: corta el reloj del turno adoptado ----------
slice_rep("  function resetTransient() {",
          "  async function openSession(entry) {",
          """  function resetTransient() {
    state.msgs.clear();
    state.tools.clear();
    state.attachments = [];
    state.runId = null;
    state.adopted = false;
    state.steers.clear();
    state.queue = [];
    stopRunWatch();
    renderAttachments();
    finishStream();
    runBarHide();
  }

""", 'resetTransient')

# ---------- 7. openSession -> renderSession (+ adopcion al abrir) ----------
OLD_OPEN = """  async function openSession(entry) {
    if (state.busy) { systemNote('Esperá a que termine la respuesta actual.'); return; }"""
NEW_OPEN = """  async function openSession(entry) {
    if (state.busy) { systemNote('Esperá a que termine la respuesta actual.'); return; }
    stopRunWatch();
    await renderSession(entry);
    await checkAdoptedRun();
  }

  // Carga una sesión en pantalla (replay del historial + chips). Sin la guarda de
  // "busy": también la usa el refresco periódico de un turno adoptado.
  async function renderSession(entry, opts) {
    const id = entry.sessionId || entry.id;
    state.current = { id, title: entry.title || 'Sesión', cwd: entry.cwd, configOptions: entry.configOptions || [], modes: entry.modes || {} };
    resetTransient();
    clearMessages();
    updateTitle(); markActive(id); closeDrawer();
    localStorage.setItem('gweb.last', id);
    if (!opts || !opts.quiet) setPill('Cargando conversación.');
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
    flushRender(); // pinta lo que haya quedado pendiente del replay
    setPill(null);
    if (state.msgs.size) hideWelcome();
    else showWelcome('empty', state.current.title);
    updateMetaHints();
    scrollBottom(true);
  }"""
rep(OLD_OPEN, NEW_OPEN, 'openSession')

# borra el cuerpo viejo de openSession (quedo duplicado tras el split)
OLD_BODY = """    state.current = { id: entry.sessionId, title: entry.title || 'Sesión', cwd: entry.cwd, configOptions: [], modes: {} };
    resetTransient();
    clearMessages();
    updateTitle(); markActive(entry.sessionId); closeDrawer();
    localStorage.setItem('gweb.last', entry.sessionId);
    setPill('Cargando conversaci\u00f3n\u2026');
    state.replaying = true;
    try {
      const res = await rpc.request('session/load', { sessionId: entry.sessionId, cwd: entry.cwd, mcpServers: [] });
      if (res && Array.isArray(res.configOptions)) state.current.configOptions = res.configOptions;
      if (res && res.modes) state.current.modes = res.modes;
      renderChips();
    } catch (e) {
      systemNote('No se pudo cargar la sesión: ' + e.message);
    }
    state.replaying = false;
    flushRender(); // pinta lo que haya quedado pendiente del replay
    setPill(null);
    if (state.msgs.size) hideWelcome();
    else showWelcome('empty', state.current.title);
    updateMetaHints();
    scrollBottom(true);
  }

"""
rep(OLD_BODY, "", 'openSession-viejo')

# ---------- 8. runBarHide deja tambien el boton oculto ----------
rep("    if (bar) { bar.hidden = true; bar.classList.remove('done', 'cancelling'); }",
    """    if (bar) { bar.hidden = true; bar.classList.remove('done', 'cancelling'); }
    const stopBtn = $('#runbar-stop'); if (stopBtn) stopBtn.hidden = true;""", 'runBarHide')

# ---------- 9. endRun corta el reloj ----------
rep("""  function endRun(text) {
    state.adopted = false;
    if (state.busy) setBusy(false, text);
  }""",
    """  function endRun(text) {
    state.adopted = false;
    stopRunWatch();
    if (state.busy) setBusy(false, text);
  }""", 'endRun')

# ---------- 10. setBusy: arranque explicito + cierre de turno con reencolado ----------
slice_rep("  function setBusy(b, note) {",
          "  function updateMetaHints() {",
          """  function setBusy(b, note, startAt) {
    const was = state.busy;
    state.busy = b;
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

""", 'setBusy')

# ---------- 11. enviar / steering / adopcion ----------
NEW_SEND = """  async function sendText(text, atts, bubble) {
    const el = bubble || addUser(text, false, atts);
    state.adopted = false;
    setBusy(true, 'Aegis está trabajando.');
    let label = 'Respuesta completa';
    let loMandoComoIndicacion = false;
    try {
      const res = await rpc.request('session/prompt', { sessionId: state.current.id, prompt: promptBlocks(text, atts) });
      if (res && res.usage && res.usage.totalTokens != null) setUsage({ used: res.usage.totalTokens });
      stopNote(res && res.stopReason);
      const sr = res && res.stopReason;
      if (sr === 'cancelled') label = 'Turno detenido';
      else if (sr && sr !== 'end_turn') label = 'Turno interrumpido (' + sr + ')';
    } catch (e) {
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
      if (loMandoComoIndicacion && state.busy) {
        // el turno sigue vivo en otra conexión: seguimos en modo adoptado
        runBarShow(ADOPTED_NOTE);
        startRunWatch();
      } else {
        setBusy(false, label);
      }
      refreshSessions();
      flushQueue();
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
      const res = await rpc.request('_aegis/unstable/session/steer', {
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
    const text = q.map((x) => x.text).filter(Boolean).join('\\n\\n');
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
  const RUN_WATCH_MS = 2500;
  let runWatch = 0;
  let watchKey = '';
  let watchSince = 0;
  const ADOPTED_NOTE = 'Turno en curso (lo arrancó otra conexión)';
  const setRunBarText = (t) => { const b = $('#runbar-text'); if (b) b.textContent = t; };

  // ¿Hay un run activo en esta sesión, y con qué id? `session/steer` con un
  // expectedRunId imposible: el server valida el run ANTES de tocar al agente, así que
  // no encola nada, y contesta con el run real ("actualRunId") o con "no active run".
  async function activeRunId() {
    if (!rpc.ready || !state.current) return { known: false, runId: null };
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
      const msg = String((e && e.message) || '');
      if (/no active run to steer/i.test(msg)) return { known: true, runId: null };
      report('steer', 'sondeo de run falló: ' + msg.slice(0, 200));
      return { known: false, runId: null };
    }
  }

  function adoptRun(runId, note, startedAt) {
    state.adopted = true;
    if (runId) state.runId = runId;
    const text = note || ADOPTED_NOTE;
    if (!state.busy) setBusy(true, text, startedAt);
    else { runBarShow(text); setRunBarText(text); }
    startRunWatch();
  }

  function startRunWatch() {
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
    const probe = await activeRunId();
    if (!state.current) return;
    if (probe.known && !probe.runId) {
      stopRunWatch();
      await endAdoptedRun();
      return;
    }
    if (probe.runId && probe.runId !== state.runId) state.runId = probe.runId;
    if (!state.busy) adoptRun(probe.runId, ADOPTED_NOTE);
    const info = await rpc.request('_aegis/unstable/session/info', { sessionId: cur.id }).catch(() => null);
    const meta = (info && info.session && info.session._meta) || {};
    const key = meta.messageCount != null ? String(meta.messageCount) + '|' + String(meta.lastMessageAt || '') : '';
    if (key && watchKey && key !== watchKey) await resyncAdoptedRun();
    if (key) watchKey = key;
  }

  async function endAdoptedRun() {
    await resyncAdoptedRun(); // trae lo último que el turno persistió
    state.adopted = false;
    state.runId = null;
    if (state.busy) setBusy(false, 'El turno terminó (otra conexión)');
  }

  // Recarga la conversación del server conservando el turno adoptado (barra,
  // cronómetro, Detener y las indicaciones en cola).
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
      if (text && textInServerHistory(text)) {
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

  const wordsOf = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim();

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
      if (textInServerHistory(text)) continue; // se consumió y quedó en el historial
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
      adoptRun(probe.runId, 'Turno en curso (seguía corriendo al recargar)');
      systemNote('Este turno ya estaba en curso cuando abriste la página: se sigue con refresco periódico (el streaming en vivo va a la conexión que lo arrancó).');
      return true;
    }
    stopRunWatch();
    if (!state.busy) flushPendingSteers();
    return false;
  }

"""
slice_rep("  async function sendText(text, atts) {",
          "  // ---------- chips (config options) ----------",
          NEW_SEND, 'enviar/steering/adopcion')

# ---------- 12. onBoot ----------
slice_rep("  async function onBoot() {",
          "  function wire() {",
          """  async function onBoot() {
    $('#conn-host').textContent = CFG.host || '';
    renderChips();
    updateMetaHints();
    await refreshSessions();
    const last = localStorage.getItem('gweb.last');
    const entry = findSession(last);
    if (entry) await openSession(entry);
    else { clearMessages(); showWelcome('new'); await checkAdoptedRun(); }
    refreshSlashMenu();
    report('boot', 'ok - sesiones=' + state.sessions.length + ' archivadas=' + state.archived.length + ' adoptado=' + state.adopted);
  }

""", 'onBoot')

# ---------- 13. superficie de depuracion + version ----------
rep("  window.__aegisWeb = { state, showWelcome, refreshSessions, slashCommands: () => state.slash.slice(), dropSocket: () => { try { rpc.ws.close(); } catch {} } };",
    "  window.__aegisWeb = { state, showWelcome, refreshSessions, slashCommands: () => state.slash.slice(), dropSocket: () => { try { rpc.ws.close(); } catch {} }, probeRun: activeRunId, resync: resyncAdoptedRun, adopt: adoptRun, pendingSteers: loadPending };", 'debug-surface')
rep("  report('boot', 'app cargada (v5)');", "  report('boot', 'app cargada (v6)');", 'version')

out = text.encode('utf-8')
open(P, 'wb').write(out)
print('escrito:', len(out), 'bytes (antes', len(raw), ')')
