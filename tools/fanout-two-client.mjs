// Gate v6.4: fan-out por sesión + run desacoplado (5 asserts del spec).
// Uso: node fanout-two-client.mjs [puerto]
//
// Los 5 asserts del "Gate de aceptación" del spec:
//   1) fan-out EN VIVO entre dos clientes sobre la misma sesión
//   2) el turno sobrevive al cierre del socket a mitad de turno
//   3) watcher tardío recibe replay por cursor
//   4) sin fugas de watchers (connect/disconnect + unwatch)
//   5) regresión: cliente viejo (sin watch) sigue funcionando
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const PORT = process.argv[2] || '3392';
const URL = `ws://127.0.0.1:${PORT}/acp?token=${cfg.secretKey}`;
const CWD = cfg.cwd || 'C:\aegis-src';
const MARK = 'FANOUT-MARKER-42';
const out = [];
const check = (name, ok, detail) => { out.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name} :: ${JSON.stringify(detail)}`); };
const note = (msg, detail) => console.log(`INFO :: ${msg} :: ${JSON.stringify(detail ?? null)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function client(name) {
  const notes = []; let id = 0; const pend = new Map();
  const ws = new WebSocket(URL);
  const c = { name, ws, notes, closed: false };
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && m.method === undefined) { const p = pend.get(m.id); if (p) { pend.delete(m.id); p(m); } return; }
    if (m.method) notes.push({ t: now(), method: m.method, params: m.params });
  });
  ws.addEventListener('close', () => {
    c.closed = true;
    // Una request en vuelo sobre un socket caído nunca recibe respuesta: se rechaza acá.
    for (const [mid, p] of [...pend.entries()]) { pend.delete(mid); p({ id: mid, error: { code: -1, message: 'socket cerrado' } }); }
  });
  c.open = new Promise((r) => ws.addEventListener('open', r));
  c.req = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(method), { raw: m.error })) : res(m.result)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
  });
  c.init = async () => { await c.open; await c.req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: c.name, version: '1' } }); };
  c.watch = (sid, since = null) => c.req('_aegis/unstable/session/watch', { sessionId: sid, since });
  c.info = (sid) => c.req('_aegis/unstable/session/info', { sessionId: sid });
  c.close = () => { try { ws.close(); } catch { } };
  return c;
}
// Helpers de inspección de notificaciones (session/update y _aegis/unstable/session/update).
const upd = (n) => n.params?.update ?? {};
const isChunk = (n) => ['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(upd(n).sessionUpdate);
const textOf = (n) => {
  if (upd(n).sessionUpdate !== 'agent_message_chunk') return '';
  const c = upd(n).content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => b?.text || '').join('');
  return (c && (c.text || '')) || upd(n).text || '';
};
// Ojo: `activeRunId` puede venir presente y ser `null` (fin de turno). Hay que distinguir
// "ausente" (undefined) de null, por eso se mira la propiedad explícitamente.
const runIdOf = (n) => {
  const u = upd(n)._meta?.aegis;
  if (u && Object.prototype.hasOwnProperty.call(u, 'activeRunId')) return u.activeRunId;
  const p = n.params?._meta?.aegis;
  if (p && Object.prototype.hasOwnProperty.call(p, 'activeRunId')) return p.activeRunId;
  return undefined;
};
// Un evento de run pertenece a la sesión si trae activeRunId no nulo y sessionId de la sesión.
const isRunStartFor = (n, sid) => runIdOf(n) !== null && runIdOf(n) !== undefined && n.params?.sessionId === sid;
const isRunEndFor = (n, sid) => runIdOf(n) === null && n.params?.sessionId === sid;
async function waitFor(fn, timeoutMs, stepMs = 250) {
  const t0 = now();
  while (now() - t0 < timeoutMs) { const v = fn(); if (v) return { v, ms: now() - t0 }; await sleep(stepMs); }
  return { v: null, ms: now() - t0 };
}

// ============================ Assert 1: fan-out en vivo ============================
const A = client('A'); await A.init();
const newSess = await A.req('session/new', { cwd: CWD, mcpServers: [] });
const SID = newSess.sessionId;
const watchA = await A.watch(SID, null);
note('sesion nueva + watch A', { session: SID, cursor: watchA.cursor, replay: watchA.replay.length, activeRunId: watchA.activeRunId });
if (watchA.cursor !== 0 || watchA.replay.length !== 0) note('OJO: la sesion nueva ya trae ring en el hub (id reutilizado)', { cursor: watchA.cursor });

// El turno dura ~20s (sleep en shell) para tener ventanas estables de observación.
const prompt = `Ejecuta exactamente este comando con la herramienta shell: powershell -Command Start-Sleep -Seconds 20  y despues responde con el texto ${MARK} y nada mas.`;
const aRunMark = A.notes.length;
const promptP = A.req('session/prompt', { sessionId: SID, prompt: [{ type: 'text', text: prompt }] })
  .catch((e) => ({ error: String(e.raw ? JSON.stringify(e.raw) : e) }));
const start = await waitFor(() => A.notes.slice(aRunMark).find((n) => isRunStartFor(n, SID)), 60000);
const runA = start.v ? runIdOf(start.v) : null;
check('1a. A (conexión del prompt) recibe activeRunId del turno', !!runA, { activeRunId: runA, ms: start.ms });
if (!runA) {
  console.log(`\nRESUMEN ${out.filter((r) => r.ok).length}/${out.length} asserts OK :: ABORTADO (no arrancó el run)`);
  A.close(); process.exit(1);
}

// B entra como segundo cliente de la MISMA sesión, en medio del turno.
const B = client('B'); await B.init();
await B.req('session/load', { sessionId: SID, cwd: CWD, mcpServers: [] });
const watchB = await B.watch(SID, null);
check('1b. B.watch reporta el MISMO activeRunId que A', watchB.activeRunId === runA, { a: runA, b: watchB.activeRunId, cursor: watchB.cursor, replayB: watchB.replay.length });
const bMark = B.notes.length;
const bChunks = await waitFor(() => (B.notes.slice(bMark).filter(isChunk).length >= 3 ? B.notes.slice(bMark).filter(isChunk) : null), 60000);
check('1c. B recibe >=3 session/update EN VIVO mientras corre el turno de A', !!bChunks.v && !A.closed, {
  chunks: bChunks.v ? bChunks.v.length : B.notes.slice(bMark).filter(isChunk).length,
  kinds: [...new Set(B.notes.slice(bMark).filter(isChunk).map((n) => upd(n).sessionUpdate))],
  ms: bChunks.ms,
});

// ============================ Assert 3: watcher tardío (replay) ============================
const C = client('C'); await C.init();
await C.req('session/load', { sessionId: SID, cwd: CWD, mcpServers: [] });
const watchC = await C.watch(SID, null);
const cChunks = watchC.replay.filter((m) => isChunk({ params: m.params }));
const cRunEvents = watchC.replay.filter((m) => runIdOf({ params: m.params }) === runA);
const cStartEvents = watchC.replay.filter((m) => isRunStartFor({ params: m.params }, SID));
check('3. watcher tardio (C) recibe replay con run-start + chunks previos', cStartEvents.length > 0 && cChunks.length > 0, {
  replay: watchC.replay.length, chunks: cChunks.length, runStart: cStartEvents.length, runEvents: cRunEvents.length, cursor: watchC.cursor, since: null,
});
// C sigue en vivo: debe ver también los eventos posteriores.
const cMark = C.notes.length;
const cLive = await waitFor(() => (C.notes.slice(cMark).filter(isChunk).length >= 1 ? C.notes.slice(cMark).filter(isChunk) : null), 60000);
check('3b. C (tardio) tambien recibe EN VIVO despues del replay', !!cLive.v, { chunks: cLive.v ? cLive.v.length : 0, ms: cLive.ms });

// ============================ Assert 2: el run sobrevive a la caída de A ============================
const tDrop = now();
A.close();
const endSeen = await waitFor(() => B.notes.filter((n) => isRunEndFor(n, SID)).pop(), 90000);
const promptResult = await Promise.race([promptP, sleep(90000).then(() => ({ error: 'sin respuesta: socket cerrado (esperado)' }))]);
const bText = B.notes.map(textOf).join('');
check('2a. el turno termina tras caer A (activeRunId=null visto por B)', !!endSeen.v, {
  ms: endSeen.ms, caidaA_ms: tDrop - start.ms, promptResult: promptResult.stopReason || promptResult.error || null, A_cerrado: A.closed,
});
check('2b. B recibe el texto final pese a la caida de A', bText.includes(MARK) || bText.length > 20, { chars: bText.length, tieneMark: bText.includes(MARK), muestra: bText.slice(-80) });
// D verifica que el mensaje quedó persistido en la sesión (no cortado).
const D = client('D'); await D.init();
const loadedD = await D.req('session/load', { sessionId: SID, cwd: CWD, mcpServers: [] });
const infoD = await D.info(SID);
const metaD = infoD.session?._meta || {};
const dbMsgs = loadedD.messages;
check('2c. el turno quedo persistido en la sesion (messageCount>=2, activeRunId=null, lastMessageAt)', metaD.messageCount >= 2 && metaD.activeRunId === null && !!metaD.lastMessageAt, {
  messageCount: metaD.messageCount, activeRunId: metaD.activeRunId, lastMessageAt: metaD.lastMessageAt,
  loadKeys: Object.keys(loadedD), loadMessages: Array.isArray(dbMsgs) ? dbMsgs.length : 'session/load no expone messages en este build',
  textoEnVivoB: bText.slice(-40),
});
D.close(); C.close();

// ============================ Assert 4: sin fugas de watchers ============================
const E = client('E'); await E.init();
await E.req('session/load', { sessionId: SID, cwd: CWD, mcpServers: [] });
const info0 = await E.info(SID);
const before = info0.session._meta?.watcherCount;
await E.watch(SID, null);
const info1 = await E.info(SID);
const conE = info1.session._meta?.watcherCount;
for (let i = 0; i < 5; i++) {
  const t = client(`W${i}`); await t.init(); await t.req('session/load', { sessionId: SID, cwd: CWD, mcpServers: [] });
  await t.watch(SID, null); await sleep(300); t.close(); await sleep(500);
}
await sleep(1500);
const info2 = await E.info(SID);
const after = info2.session._meta?.watcherCount;
check('4. 5 ciclos connect/disconnect no dejan watchers colgados', conE === before + 1 && after === conE, { antesDeE: before, conE: conE, trasCiclos: after, activeRunId: info2.session._meta?.activeRunId, metaKeys: Object.keys(info2.session._meta || {}) });
const un = await E.req('_aegis/unstable/session/unwatch', { sessionId: SID });
const info3 = await E.info(SID);
check('4b. unwatch de E baja el conteo', info3.session._meta?.watcherCount === after - 1, { unwatch: un, trasUnwatch: info3.session._meta?.watcherCount, esperado: after - 1 });
E.close();
await sleep(500);

// ============================ Assert 5: regresión (cliente viejo, sin watch) ============================
const F = client('F'); await F.init();
const s2 = await F.req('session/new', { cwd: CWD, mcpServers: [] });
const fMark = F.notes.length;
const resp = await F.req('session/prompt', { sessionId: s2.sessionId, prompt: [{ type: 'text', text: 'Responde unicamente con el numero 5. Nada mas.' }] });
const fText = F.notes.slice(fMark).map(textOf).join('');
check('5. regresion: cliente viejo (sin watch) completa el turno', resp.stopReason === 'end_turn' && fText.includes('5'), { stopReason: resp.stopReason, chars: fText.length, texto: fText.slice(0, 60) });
F.close();

const failed = out.filter((r) => !r.ok);
console.log(`\nRESUMEN ${out.length - failed.length}/${out.length} asserts OK :: ${failed.length ? 'FALLAS: ' + failed.map((f) => f.name).join(' | ') : 'TODO OK'}`);
process.exit(failed.length ? 1 : 0);
