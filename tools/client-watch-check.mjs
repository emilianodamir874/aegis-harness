// client-watch-check.mjs — verificación del contrato v6.4 del lado CLIENTE (FRENTE B).
//
// Valida `_aegis/unstable/session/watch` (fan-out por sesión) con varias conexiones ACP
// contra el server v4, sin browser:
//   A: initialize + session/new + watch + session/prompt con una tool LENTA -> dueño del run.
//   B: initialize + session/load + watch(since=null) -> debe ver el streaming EN VIVO del
//      turno de A (chunks posteriores a la respuesta de watch, no por session/load periódico)
//      con el MISMO activeRunId, y recibir el fin de turno (activeRunId=null) aunque A cierre
//      su socket a mitad del turno.
//   C: entra TARDE con watch(since=null) -> el replay debe traer lo ya emitido.
//   B reconecta y re-watch con el último cursor; C dispara un segundo turno corto y B debe
//   seguir viendo los chunks en vivo.
//   Extra: watcherCount de session/info tras 5 ciclos connect/disconnect de un watcher.
//
// Uso: node tools/client-watch-check.mjs [puerto-v4=3392]
//      (o CWC_URL=ws://host:puerto/acp?token=... para apuntar a otro lado)
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const port = process.argv[2] || '3392';
const url = process.env.CWC_URL || `ws://${cfg.publicHost}:${port}/acp?token=${cfg.secretKey}`;
const T0 = Date.now();
const seg = () => Number(((Date.now() - T0) / 1000).toFixed(1));
const log = (...a) => console.log('[' + seg() + 's]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { puerto: port, url: url.replace(/token=.*/, 'token=***'), ok: false, pasos: {}, asserts: {}, errores: [] };

// activeRunId en cualquiera de las formas del contrato (notificación aegis o session/update)
function runIdOf(m) {
  const p = m.params || {};
  const g = p.aegis || (p.update && p.update._meta && p.update._meta.aegis) || (p._meta && p._meta.aegis) || null;
  if (g && g.activeRunId !== undefined) return g.activeRunId;
  const u = p.update || {};
  if (u.sessionUpdate === 'session_info_update') {
    const gg = (u._meta && u._meta.aegis) || {};
    if (gg.activeRunId !== undefined) return gg.activeRunId;
  }
  return undefined;
}

function mkClient(name) {
  const c = { name, id: 0, pend: new Map(), ws: null, sid: null, cursor: null, watchCtx: false, live: [], replay: [], runIds: [], text: '', perms: 0, seen: {} };
  c.connect = () => new Promise((res, rej) => {
    const ws = new WebSocket(url);
    c.ws = ws;
    ws.addEventListener('open', () => res(true));
    ws.addEventListener('error', () => rej(new Error('error de websocket en ' + name)));
    ws.addEventListener('close', () => {
      for (const p of [...c.pend.values()]) { try { p({ error: { code: -1, message: 'socket cerrado' } }); } catch {} }
      c.pend.clear();
    });
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined && m.method === undefined) { const p = c.pend.get(m.id); if (p) { c.pend.delete(m.id); p(m); } return; }
      if (m.method === 'session/request_permission') {
        c.perms++;
        const opt = (m.params.options || []).find((o) => o.optionId === 'allow_once') || (m.params.options || [])[0];
        if (opt) ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
        return;
      }
      const rid = runIdOf(m);
      if (rid !== undefined) c.runIds.push({ t: seg(), rid });
      if (m.method === 'session/update' || m.method === '_aegis/unstable/session/update' || m.method === '_aegis/unstable/session/replay_gap') {
        const u = (m.params && m.params.update) || {};
        const kind = u.sessionUpdate || m.method;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') c.text += u.content.text;
        if (c.watchCtx) {
          c.live.push({ t: seg(), kind, rid: rid === undefined ? null : rid });
          c.seen[kind] = (c.seen[kind] || 0) + 1;
        }
      }
    });
  });
  c.req = (method, params) => new Promise((res, rej) => {
    const mid = ++c.id;
    c.pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 240)), { rpc: m.error })) : res(m.result)));
    try { c.ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); }
    catch (e) { c.pend.delete(mid); rej(e); }
  });
  c.connect2 = async () => {
    await c.connect();
    await c.req('initialize', {
      protocolVersion: 1,
      clientCapabilities: { _meta: { aegis: { customNotifications: true } } },
      clientInfo: { name: 'client-watch-check-' + name, version: '1' },
    });
  };
  c.watch = async (since) => {
    const res = await c.req('_aegis/unstable/session/watch', { sessionId: c.sid, since: since == null ? null : since });
    c.cursor = res && res.cursor;
    c.replay = (res && res.replay) || [];
    if (res && res.activeRunId !== undefined) c.runIds.push({ t: seg(), rid: res.activeRunId, watchRes: true });
    c.watchCtx = true;
    return res;
  };
  c.close = () => { try { c.ws.close(); } catch {} };
  return c;
}

const A = mkClient('A'), B = mkClient('B'), C = mkClient('C');
let A_prompt = null, C_prompt2 = null;

function dump() {
  out.resumen = {
    asserts: out.asserts,
    pasos: out.pasos,
    liveB: B.live.length,
    liveBKinds: B.seen,
    runIdsB: B.runIds.slice(0, 12),
    runIdsA: A.runIds.slice(0, 8),
    textoB: B.text.slice(0, 400),
    textoC: C.text.slice(0, 200),
  };
  console.log('\n=== RESULTADO (JSON) ===');
  console.log(JSON.stringify(out, null, 1));
  console.log('\n=== RESUMEN COMPACTO ===');
  console.log(JSON.stringify({
    ok: out.ok, asserts: out.asserts, errores: out.errores,
    pasos: { A_watch: out.pasos.A_watch, B_join: out.pasos.B_join, C_join: out.pasos.C_join, fin_de_turno: out.pasos.fin_de_turno, B_rewatch: out.pasos.B_rewatch, segundo_turno: out.pasos.segundo_turno, watcherCount: out.pasos.watcherCount, delete: out.pasos.delete, unwatch_B: out.pasos.unwatch_B, unwatch_C: out.pasos.unwatch_C },
  }));
}
const HARD = setTimeout(() => { out.errores.push('timeout global (240 s)'); dump(); process.exit(0); }, 240000);

async function main() {
  // ---------- A: sesión nueva, watch y prompt con tool lenta ----------
  await A.connect2();
  const s = await A.req('session/new', { cwd: cfg.cwd, mcpServers: [] });
  A.sid = s.sessionId;
  const wA = await A.watch(null);
  out.pasos.A_watch = { sid: A.sid, cursor: wA && wA.cursor, activeRunId: wA && wA.activeRunId, replay: (wA && wA.replay && wA.replay.length) || 0 };
  log('A: sesión ' + A.sid + ' / watch ok cursor=' + (wA && wA.cursor));

  const promptText = 'Usá la herramienta execute_typescript (no contestes de memoria) con este código exacto:\nawait new Promise((r) => setTimeout(r, 12000));\nconsole.log("sleep ok");\nDespués de la herramienta respondé exactamente: LISTO-FANOUT';
  A_prompt = A.req('session/prompt', { sessionId: A.sid, prompt: [{ type: 'text', text: promptText }] })
    .then((r) => ({ ok: true, stopReason: r && r.stopReason }))
    .catch((e) => ({ ok: false, error: String(e.message).slice(0, 240) }));
  log('A: lanzó session/prompt (tool lenta ~12 s)');

  // ---------- B: entra con el turno ya en curso ----------
  await sleep(2500);
  await B.connect2();
  B.sid = A.sid;
  const loadB = await B.req('session/load', { sessionId: B.sid, cwd: cfg.cwd, mcpServers: [] });
  const wB = await B.watch(null);
  out.pasos.B_join = { loadOk: !!loadB, cursor: wB && wB.cursor, activeRunId: wB && wB.activeRunId, replay: (wB && wB.replay && wB.replay.length) || 0 };
  log('B: load + watch -> activeRunId=' + (wB && wB.activeRunId) + ' replay=' + ((wB && wB.replay && wB.replay.length) || 0));

  // ---------- C: entra TARDE (el replay debe traer lo ya emitido) ----------
  await sleep(3000);
  await C.connect2();
  C.sid = A.sid;
  await C.req('session/load', { sessionId: C.sid, cwd: cfg.cwd, mcpServers: [] });
  const wC = await C.watch(null);
  const cKinds = {};
  for (const n of wC.replay || []) { const u = (n.params && n.params.update) || {}; const k = u.sessionUpdate || n.method; cKinds[k] = (cKinds[k] || 0) + 1; }
  out.pasos.C_join = { cursor: wC && wC.cursor, activeRunId: wC && wC.activeRunId, replay: (wC && wC.replay && wC.replay.length) || 0, replayKinds: cKinds };
  log('C (tarde): replay=' + ((wC && wC.replay && wC.replay.length) || 0) + ' ' + JSON.stringify(cKinds));

  // ---------- A cierra su socket A MITAD DEL TURNO ----------
  await sleep(2000);
  const liveBBeforeDrop = B.live.length;
  const dropT = seg();
  A.close();
  log('A: socket cerrado a mitad del turno (B llevaba ' + liveBBeforeDrop + ' eventos en vivo)');

  // ---------- Fin de turno por EVENTO (activeRunId=null) en B ----------
  const tWait = Date.now();
  let ended = null;
  while (Date.now() - tWait < 120000) {
    const zero = B.runIds.find((x) => x.rid === null || x.rid === undefined) || null;
    const hadRun = B.runIds.some((x) => typeof x.rid === 'string' && x.rid.startsWith('run'));
    if (zero && hadRun) { ended = zero; break; }
    await sleep(500);
  }
  const liveKinds = {};
  for (const x of B.live) liveKinds[x.kind] = (liveKinds[x.kind] || 0) + 1;
  const liveAfterDrop = B.live.filter((x) => x.t > dropT).length;
  const liveChunks = (liveKinds.agent_message_chunk || 0) + (liveKinds.agent_thought_chunk || 0) + (liveKinds.tool_call || 0) + (liveKinds.tool_call_update || 0);
  const runA = (A.runIds.find((x) => typeof x.rid === 'string') || {}).rid || null;
  const runB = (B.runIds.find((x) => typeof x.rid === 'string') || {}).rid || null;
  const pARes = await Promise.race([A_prompt, sleep(1000).then(() => ({ ok: null, nota: 'prompt de A sin resolver (su socket murió)' }))]);
  out.pasos.fin_de_turno = {
    evento_activeRunId_null: ended ? ended.t : null,
    null_por_evento_no_por_watch: ended ? !ended.watchRes : null,
    liveB: B.live.length, liveB_post_drop: liveAfterDrop, kinds: liveKinds,
    runA, runB, promptA: pARes, permsA: A.perms, permsB: B.perms, permsC: C.perms,
  };
  out.asserts.A_watch_actiona_run = { ok: A.runIds.some((x) => typeof x.rid === 'string'), evento_de_arranque: A.runIds.map((x) => x.rid).join(','), watch_resp: wA && wA.activeRunId };
  out.asserts.B_ve_chunks_en_vivo = { ok: liveChunks >= 3, chunks: liveChunks, kinds: liveKinds };
  out.asserts.B_mismo_run_que_A = { ok: !!runA && runA === runB, runA, runB };
  out.asserts.B_sigue_viendo_tras_morir_A = { ok: liveAfterDrop >= 1, eventos_post_drop: liveAfterDrop };
  out.asserts.B_recibe_fin_de_turno_por_evento = { ok: !!ended, t: ended ? ended.t : null };
  out.asserts.C_tarde_recibe_replay = { ok: ((wC && wC.replay && wC.replay.length) || 0) >= 1, replay: (wC && wC.replay && wC.replay.length) || 0, kinds: cKinds };
  out.asserts.B_texto_final = { ok: /LISTO-FANOUT|OK/.test(B.text), texto: B.text.slice(0, 200) };
  log('B: fin de turno ' + (ended ? 'por EVENTO a los ' + ended.t + 's' : 'NO detectado') + ' / chunks en vivo=' + liveChunks);

  // ---------- B reconecta y re-watch con el último cursor ----------
  const curBefore = B.cursor;
  B.close();
  await sleep(1200);
  await B.connect2();
  const wB2 = await B.watch(curBefore);
  const gap = ((wB2 && wB2.replay) || []).some((n) => n.method === '_aegis/unstable/session/replay_gap');
  out.pasos.B_rewatch = { cursorAntes: curBefore, cursorDespues: wB2 && wB2.cursor, activeRunId: wB2 && wB2.activeRunId, replay: (wB2 && wB2.replay && wB2.replay.length) || 0, replay_gap: gap };
  log('B: re-watch con cursor=' + curBefore + ' -> cursor=' + (wB2 && wB2.cursor) + ' replay=' + ((wB2 && wB2.replay && wB2.replay.length) || 0) + ' gap=' + gap);
  out.asserts.B_rewatch_con_cursor = { ok: (wB2 && typeof wB2.cursor === 'number') && (wB2.cursor >= curBefore), cursorAntes: curBefore, cursorDespues: wB2 && wB2.cursor, gap };

  // ---------- Segundo turno corto disparado por C: B (re-enganchado) lo ve en vivo ----------
  const liveAntes = B.live.length;
  C_prompt2 = C.req('session/prompt', { sessionId: C.sid, prompt: [{ type: 'text', text: 'Usá execute_typescript con:\nawait new Promise((r) => setTimeout(r, 6000));\nDespués respondé exactamente: SEGUNDO-TURNO' }] })
    .then((r) => ({ ok: true, stopReason: r && r.stopReason }))
    .catch((e) => ({ ok: false, error: String(e.message).slice(0, 200) }));
  const t2 = Date.now();
  let delta = 0;
  while (Date.now() - t2 < 90000) {
    delta = B.live.length - liveAntes;
    if (delta >= 2) break;
    await sleep(500);
  }
  const pC2 = await Promise.race([C_prompt2, sleep(6000).then(() => ({ ok: null, nota: 'prompt de C todavia en vuelo' }))]);
  out.pasos.segundo_turno = { live_en_B_reenganchado: delta, promptC: pC2, kindsB: B.seen };
  out.asserts.B_ve_el_segundo_turno = { ok: delta >= 2, eventos: delta };
  log('B re-enganchado: ' + delta + ' eventos en vivo del segundo turno');

  // ---------- watcherCount tras 5 ciclos connect/disconnect de un watcher extra ----------
  for (let i = 0; i < 5; i++) {
    const X = mkClient('X' + i);
    await X.connect2();
    X.sid = A.sid;
    await X.watch(null).catch(() => {});
    X.close();
    await sleep(200);
  }
  await sleep(1500);
  let info = null;
  try { info = await C.req('_aegis/unstable/session/info', { sessionId: A.sid }); }
  catch (e) { out.errores.push('session/info falló: ' + String(e.message).slice(0, 160)); }
  out.pasos.watcherCount = {
    valor: info && info.session && info.session._meta ? info.session._meta.watcherCount : undefined,
    esperado: 2,
    activeRunIdInfo: info && info.session && info.session._meta ? info.session._meta.activeRunId : undefined,
  };
  out.asserts.watcherCount_sin_fugas = { ok: !!info && info.session._meta.watcherCount === 2, valor: out.pasos.watcherCount.valor, esperado: 2 };

  // ---------- limpieza ----------
  try { const del = await C.req('session/delete', { sessionId: A.sid }); out.pasos.delete = { ok: !!del }; } catch (e) { out.pasos.delete = { ok: false, error: String(e.message).slice(0, 160) }; }
  for (const c of [B, C]) { try { await c.req('_aegis/unstable/session/unwatch', { sessionId: c.sid }); out.pasos['unwatch_' + c.name] = true; } catch (e) { out.pasos['unwatch_' + c.name] = String(e.message).slice(0, 120); } }

  const list = Object.values(out.asserts);
  out.ok = list.every((a) => a.ok === true);
  clearTimeout(HARD);
  dump();
  for (const c of [B, C]) c.close();
  process.exit(0);
}

try {
  await main();
} catch (e) {
  out.errores.push('excepción: ' + String((e && e.stack) || e).slice(0, 500));
  clearTimeout(HARD);
  dump();
  for (const c of [A, B, C]) c.close();
  process.exit(0);
}
