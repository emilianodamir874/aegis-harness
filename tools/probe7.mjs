// probe7: archive / unarchive / export contra el server real (los tres métodos que usa la UI v4).
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0;
const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) => new Promise((res, rej) => {
  const mid = ++id;
  pend.set(mid, (m) => (m.error ? rej(new Error(method + ' -> ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result)));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
});
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'probe7', version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });

const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
console.log('sesión:', s.sessionId);
await req('_aegis/unstable/session/rename', { sessionId: s.sessionId, title: 'PROBE7 archive test' });

const list = async (tag) => {
  const r = await req('session/list', { meta: { aegis: { includeLastMessageSnippet: false } } });
  const me = (r.sessions || []).find((x) => x.sessionId === s.sessionId);
  console.log(tag, me ? `title="${me.title}" archivedAt=${me._meta?.archivedAt ?? 'null'}` : 'NO aparece en session/list');
};

await list('antes      :');
try { await req('_aegis/unstable/session/archive', { sessionId: s.sessionId }); console.log('archive    : OK'); }
catch (e) { console.log('archive    :', String(e).slice(0, 200)); }
await list('tras arch  :');
try { await req('_aegis/unstable/session/unarchive', { sessionId: s.sessionId }); console.log('unarchive  : OK'); }
catch (e) { console.log('unarchive  :', String(e).slice(0, 200)); }
await list('tras desarch:');

for (const format of ['markdown', 'json']) {
  try {
    const r = await req('_aegis/unstable/session/export', { sessionId: s.sessionId, format });
    console.log('export', format, '-> bytes:', (r?.data || '').length, '| head:', JSON.stringify((r?.data || '').slice(0, 60)));
  } catch (e) { console.log('export', format, ':', String(e).slice(0, 200)); }
}
await req('session/delete', { sessionId: s.sessionId }).catch(() => {});
ws.close();
process.exit(0);
