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
    if (key && key !== hotLast && hotLast) { hotIdle = 0; await softResync(false); }
    else hotIdle++;
    hotLast = key;
    WATCH_DBG.hotTicks = (WATCH_DBG.hotTicks || 0) + 1;
    if (!fresh && hotIdle > 3) { WATCH_DBG.hotEnds = (WATCH_DBG.hotEnds || 0) + 1; stopHotWatch(); await endAdoptedRun(); }
  }
  function startHotWatch() { if (hotWatch) return; hotIdle = 0; hotLast = ''; hotWatch = setInterval(hotTick, 2500); hotTick(); }
