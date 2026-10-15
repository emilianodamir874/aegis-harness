// Read-only: segunda conexion a una sesion con run activo -> cuenta notificaciones.
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const SID = process.argv[2];
let id = 0; const pend = new Map(); const notes = [];
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined) { const p = pend.get(m.id); if (p) { pend.delete(m.id); p(m); } return; }
  if (m.method) notes.push({ t: Date.now(), method: m.method, update: m.params && m.params.update && m.params.update.sessionUpdate, meta: m.params && m.params.update && m.params.update._meta });
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(method), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'fanout-probe', version: '1' } });
const t0 = Date.now();
const loaded = await req('session/load', { sessionId: SID, cwd: cfg.cwd, mcpServers: [] });
const afterLoad = notes.length;
notes.length = 0;
// sonda de run activo
let runState = 'unknown';
try { await req('_aegis/unstable/session/steer', { sessionId: SID, prompt: [{ type: 'text', text: '(probe)' }], expectedRunId: 'run_probe-invalido' }); runState = 'steer aceptado(?)'; }
catch (e) { runState = JSON.stringify((e.raw && e.raw.data) || e.raw || String(e)).slice(0, 120); }
const T = 30;
await new Promise((r) => setTimeout(r, T * 1000));
const kinds = {};
for (const n of notes) { const k = n.update || n.method; kinds[k] = (kinds[k] || 0) + 1; }
console.log(JSON.stringify({ sid: SID, loadMs: Date.now() - t0 - T * 1000, notifEnLoad: afterLoad, runState, ventanaSeg: T, notificaciones: kinds, total: notes.length, detalle: notes.slice(0, 12).map((n) => ({ u: n.update || n.method, meta: n.meta })) }, null, 1));
ws.close(); process.exit(0);
