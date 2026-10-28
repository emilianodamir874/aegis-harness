// Imprime la forma real de `_aegis/unstable/session/export` sobre una sesión existente (sólo lectura).
// Uso: node tools/acp-export-shape.mjs [sessionId] [markdown|json]
import { WebSocket } from 'ws';

const config = await (await fetch('http://127.0.0.1:3788/config.js')).text();
const search = new URL(/"acpUrl"\s*:\s*"([^"]+)"/.exec(config)[1]).search;
const socket = new WebSocket(`ws://127.0.0.1:3788/acp${search}`);

let id = 0;
const pending = new Map();
socket.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  const slot = msg.id !== undefined ? pending.get(msg.id) : undefined;
  if (!slot) return;
  pending.delete(msg.id);
  msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
});
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const rid = ++id;
    pending.set(rid, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }));
  });

await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
await send('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'aegis-web-react-export-shape', version: '0.1.0' },
});

let sid = process.argv[2];
if (!sid) {
  const list = await send('session/list', { meta: { aegis: { includeLastMessageSnippet: false } } });
  sid = (list.sessions ?? [])[0]?.sessionId;
}
const formato = process.argv[3] || 'markdown';
console.log(`sesion=${sid} formato=${formato}`);
for (const intento of [{ sessionId: sid, format: formato }, { sessionId: sid }]) {
  try {
    const out = await send('_aegis/unstable/session/export', intento);
    const data = out.data;
    const tipo = typeof data;
    const claves = data && typeof data === 'object' ? Object.keys(data).join(',') : '';
    const largo = typeof data === 'string' ? data.length : JSON.stringify(data ?? null).length;
    console.log(`params=${JSON.stringify(intento)} -> keys={${Object.keys(out).join(',')}} data=${tipo}${claves ? `{${claves}}` : ''} len=${largo}`);
    const muestra = typeof data === 'string' ? data : JSON.stringify(data);
    console.log(`  muestra: ${String(muestra).slice(0, 220).replace(/\n/g, '\\n')}`);
  } catch (error) {
    console.log(`params=${JSON.stringify(intento)} -> error ${error.message}`);
  }
}
socket.close();
process.exit(0);
