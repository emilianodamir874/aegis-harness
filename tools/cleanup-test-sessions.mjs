// Borra sesiones de prueba recientes creadas por los checks automatizados
// (títulos "New Chat"/"OK-WEB response test", <= 4 mensajes, creadas hace < 60 min).
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0;
const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
});
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pend.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
  });

await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cleanup', version: '1' } });
const { sessions } = await req('session/list', { meta: { aegis: { includeLastMessageSnippet: false } } });
const now = Date.now();
const targets = sessions.filter((s) => {
  const meta = s._meta || {};
  const created = Date.parse(meta.createdAt || s.updatedAt || 0);
  const fresh = now - created < 120 * 60 * 1000;
  const testTitle = s.title === 'New Chat' || /OK-WEB|TOOL-TEST|FEATURES-v4|CLAVE-CONTEXTO|Historia del pan|Count 1 to 400|Conteo 1 a 400|audit/i.test(s.title || '');
  const small = (meta.messageCount ?? 0) <= 15;
  return fresh && testTitle && small;
});
console.log('candidatas:', targets.map((s) => `${s.sessionId} "${s.title}" (${s._meta?.messageCount} msgs, ${s._meta?.createdAt})`));
for (const t of targets) {
  try {
    await req('session/delete', { sessionId: t.sessionId });
    console.log('borrada:', t.sessionId, JSON.stringify(t.title));
  } catch (e) {
    console.log('error borrando', t.sessionId, String(e).slice(0, 160));
  }
}
ws.close();
process.exit(0);
