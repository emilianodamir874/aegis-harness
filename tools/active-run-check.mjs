// ¿Hay un run activo en la sesión _23 ahora mismo? + meta (messageCount/lastMessageAt).
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0; const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message || 'rpc'), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'run-check', version: '1' } });
const list = await req('session/list', {});
const all = list.sessions || [];
const target = all.find((s) => s.sessionId === '20261012_23') || all.find((s) => (s.title || '').includes('Feedback recarga'));
const out = { encontrada: target ? { id: target.sessionId, title: target.title } : null, nSesiones: all.length };
if (target) {
  try {
    const r = await req('_aegis/unstable/session/steer', { sessionId: target.sessionId, prompt: [{ type: 'text', text: '.' }], expectedRunId: 'probe' + Math.random().toString(36).slice(2) });
    out.sondeo = { ok: true, result: r };
  } catch (e) { out.sondeo = { ok: false, raw: e.raw }; }
  try {
    const info = await req('_aegis/unstable/session/info', { sessionId: target.sessionId });
    const meta = (info && info.session && info.session._meta) || {};
    out.info = { messageCount: meta.messageCount, lastMessageAt: meta.lastMessageAt, activeRunId: meta.activeRunId, metaKeys: Object.keys(meta) };
  } catch (e) { out.info = String((e && e.raw) || (e && e.message) || e).slice(0, 250); }
}
console.log(JSON.stringify(out, null, 1));
ws.close(); process.exit(0);
