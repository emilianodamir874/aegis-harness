// Prueba directa del sondeo de run de v6: ¿qué responde el server real?
// 1) buscar la sesion activa "zz prueba fin de streaming" (run en curso REAL).
// 2) session/steer con expectedRunId incorrecto → ¿responde run mismatch con actualRunId,
//    o responde "Invalid params" (el bug que aparece en el cliente de Emiliano)?
// 3) también contra una sesión SIN run activo (esperado: "no active run to steer").
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0; const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message), { data: m.error.data, code: m.error.code })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'probe-steer', version: '1' } });

const list = await req('session/list', {});
const all = list.sessions || [];
const target = all.find((s) => (s.title || '').includes('zz prueba fin de streaming'));
const other = all.find((s) => s.sessionId && (!target || s.sessionId !== target.sessionId));
const out = { nSesiones: all.length, target: target ? target.sessionId : null };

async function trySteer(label, sessionId) {
  try {
    const r = await req('_aegis/unstable/session/steer', { sessionId, prompt: [{ type: 'text', text: '.' }], expectedRunId: 'probe' + Math.random().toString(36).slice(2) });
    out[label] = { ok: true, result: r };
  } catch (e) {
    out[label] = { ok: false, code: e.code, message: e.message, data: e.data };
  }
}
if (target) await trySteer('con_run_activo', target.sessionId);
if (other) await trySteer('sin_run_activo', other.sessionId);
console.log(JSON.stringify(out, null, 1));
ws.close(); process.exit(0);
