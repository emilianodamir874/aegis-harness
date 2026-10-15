// EXPERIMENTO: ¿un corte de la conexión WS dueña del turno mata el run?
// 1) WS#1: crea sesión de prueba y lanza un prompt con tool lenta (~40s).
// 2) a los 8s se CIERRA la WS#1 (simula recarga/corte, sin cancelar).
// 3) WS#2: sondea si el run sigue activo; espera a que termine; relee el historial.
// No espera la respuesta del prompt (fire-and-forget). Limpia la sesión al final.
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const ws = new WebSocket(url);
  let id = 0;
  const pend = new Map();
  const notes = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    notes.push(m);
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const req = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.method || method), { raw: m.error })) : res(m.result)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
  });
  const init = async () => {
    await ready;
    await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'wsdrop', version: '1' } });
  };
  return { ws, req, notes, ready, init };
}

const probeRun = async (c, sessionId) => {
  try {
    const r = await c.req('_aegis/unstable/session/steer', { sessionId, prompt: [{ type: 'text', text: '.' }], expectedRunId: 'probe' + Math.random().toString(36).slice(2) });
    return { ok: true, result: r };
  } catch (e) {
    return { ok: false, raw: e.raw };
  }
};
const probeText = (p) => {
  const d = p.ok ? null : (p.raw && p.raw.data);
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && d.actualRunId) return 'RUN=' + d.actualRunId;
  if (d && typeof d === 'object' && d.message) return 'RUN=' + (String(d.message).match(/run_[0-9a-f-]+/) || ['?'])[0];
  return JSON.stringify(p.raw || p.ok);
};

const out = {};
// ---------- WS#1
const c1 = connect();
await c1.init();
const s1 = await c1.req('session/new', { cwd: cfg.cwd, mcpServers: [] });
const sid = s1.sessionId;
out.sid = sid;
out.prompt = 'Corré shell: powershell -NoProfile -Command "Start-Sleep -Seconds 40". Cuando termine, respondé exactamente ZZ-DROP-DONE.';
out.t0 = new Date().toISOString();
c1.req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: out.prompt }] })
  .then((r) => { out.promptResolved1 = { stopReason: r && r.stopReason, at: new Date().toISOString() }; })
  .catch((e) => { out.promptErr1 = String((e.raw && e.raw.data) || e.message).slice(0, 200) + ' @' + new Date().toISOString(); });
await sleep(8000);
out.probeBeforeClose = probeText(await probeRun(c1, sid));
out.notesBefore = c1.notes.filter((n) => n.method === 'session/update').length;
c1.ws.close();
out.closedAt = new Date().toISOString();

// ---------- WS#2 (nueva conexión = recarga)
await sleep(1500);
const c2 = connect();
await c2.init();
out.probeAfterReconnect = probeText(await probeRun(c2, sid));

// esperar a que el run termine (o no)
for (let i = 0; i < 12; i++) {
  await sleep(5000);
  const p = probeText(await probeRun(c2, sid));
  out['t+' + (i + 1) * 5 + 's'] = p;
  if (p === 'no active run to steer') break;
}

// releer la sesión: ¿quedó ZZ-DROP-DONE persistido?
let loaded = null;
try {
  const notes = [];
  const onMsg = (m) => { if (m.method === 'session/update') notes.push(m.params.update); };
  const listener = (ev) => onMsg(JSON.parse(ev.data));
  c2.ws.addEventListener('message', listener);
  loaded = await c2.req('session/load', { sessionId: sid, cwd: cfg.cwd, mcpServers: [] });
  await sleep(2500);
  c2.ws.removeEventListener('message', listener);
  const texts = [];
  for (const u of notes) {
    const t = u && u.content && u.content.text;
    if (u && u.sessionUpdate === 'agent_message_chunk' && t) texts.push(t.slice(0, 120));
    if (u && u.sessionUpdate === 'tool_call_update' && u.status) texts.push('tool:' + u.status);
  }
  out.replayTail = texts.slice(-12);
  out.hasDone = texts.some((t) => /ZZ-DROP-DONE/.test(t));
} catch (e) { out.loadErr = String(e.raw || e.message).slice(0, 200); }

// limpiar
await c2.req('session/delete', { sessionId: sid }).catch(() => {});
c2.ws.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
