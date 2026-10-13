// Sonda de una sesión puntual: ¿run activo? Uso: node check-sid.mjs <sid>
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const sid = process.argv[2];
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0; const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message || 'rpc'), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'check-sid', version: '1' } });
const out = {};
try {
  await req('_goose/unstable/session/steer', { sessionId: sid, prompt: [{ type: 'text', text: '.' }], expectedRunId: 'probe' + Math.random().toString(36).slice(2) });
  out.activo = false;
} catch (e) {
  const d = e.raw && e.raw.data;
  if (d && typeof d === 'object' && d.actualRunId) out.activo = d.actualRunId;
  else if (typeof d === 'string' && /no active run/.test(d)) out.activo = false;
  else out.err = JSON.stringify(e.raw || e.message).slice(0, 160);
}
try {
  const info = await req('_goose/unstable/session/info', { sessionId: sid });
  const meta = (info && info.session && info.session._meta) || {};
  out.messageCount = meta.messageCount; out.lastMessageAt = meta.lastMessageAt;
} catch (e) { out.infoErr = String(e.raw || e.message).slice(0, 120); }
console.log(JSON.stringify(out));
ws.close(); process.exit(0);
