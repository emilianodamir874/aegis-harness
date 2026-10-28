// Imprime la forma real de una fila de session/list (claves de la fila y de _meta).
// Uso: node tools/acp-list-shape.mjs
import { WebSocket } from 'ws';

const config = await (await fetch('http://127.0.0.1:3788/config.js')).text();
const match = /"acpUrl"\s*:\s*"([^"]+)"/.exec(config);
if (!match) throw new Error('sin acpUrl');
const original = new URL(match[1]);
const socket = new WebSocket(`ws://127.0.0.1:3788/acp${original.search}`);

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
  clientInfo: { name: 'aegis-web-react-list-shape', version: '0.1.0' },
});
const list = await send('session/list', { meta: { aegis: { includeLastMessageSnippet: false } } });
const rows = list.sessions ?? [];
console.log(`sesiones=${rows.length} clavesFila={${Object.keys(rows[0] ?? {}).join(',')}} clavesMeta={${Object.keys(rows[0]?._meta ?? {}).join(',')}}`);
console.log(`respuesta={${Object.keys(list).join(',')}} running=${(list._meta?.runningSessionIds ?? []).length}`);
const conMeta = rows.filter((row) => row._meta && Object.keys(row._meta).length > 1).slice(0, 2);
for (const row of conMeta) console.log(`  ${row.sessionId} meta=${JSON.stringify(row._meta).slice(0, 160)}`);
socket.close();
process.exit(0);
