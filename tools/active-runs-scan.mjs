// Escaneo: ¿hay runs activos en las sesiones más recientes? (antes de reiniciar el serve)
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0; const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message || 'rpc'), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'scan', version: '1' } });
const list = await req('session/list', {});
const sessions = (list.sessions || []).slice(0, 10);
const out = [];
for (const s of sessions) {
  let run = null, err = null;
  try {
    await req('_aegis/unstable/session/steer', { sessionId: s.sessionId, prompt: [{ type: 'text', text: '.' }], expectedRunId: 'probe' + Math.random().toString(36).slice(2) });
  } catch (e) {
    const d = e.raw && e.raw.data;
    if (d && typeof d === 'object' && d.actualRunId) run = d.actualRunId;
    else if (typeof d === 'string' && /no active run/.test(d)) run = null;
    else err = JSON.stringify(e.raw || e.message).slice(0, 80);
  }
  out.push({ id: s.sessionId, titulo: (s.title || '').slice(0, 34), activo: run, err });
}
console.log(JSON.stringify(out, null, 1));
ws.close(); process.exit(0);
