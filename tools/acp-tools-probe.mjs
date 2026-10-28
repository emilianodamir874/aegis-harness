// Sondea métodos que el cliente necesita y no están probados: tools/list y el listado de sesiones
// vacías. Sólo lectura. Uso: node tools/acp-tools-probe.mjs
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
  msg.error ? slot.reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : slot.resolve(msg.result);
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
  clientInfo: { name: 'aegis-web-react-tools-probe', version: '0.1.0' },
});

for (const method of ['tools/list', '_aegis/unstable/slash-commands/list', '_aegis/unstable/sources/list']) {
  try {
    const out = await send(method, {});
    const lista = Array.isArray(out) ? out : (out?.tools ?? out?.commands ?? out?.sources ?? []);
    const nombres = (lista || []).map((item) => item?.name ?? item?.id ?? '').filter(Boolean);
    console.log(`${method} -> ok, ${nombres.length} elementos: ${nombres.slice(0, 6).join(', ')}`);
  } catch (error) {
    console.log(`${method} -> error ${error.message}`);
  }
}

const list = await send('session/list', { meta: { aegis: { includeLastMessageSnippet: false } } });
const vacias = (list.sessions ?? []).filter((row) => row._meta?.messageCount === 0);
console.log(`sesiones vacías en la primera página: ${vacias.length}`);
const sinMeta = (list.sessions ?? []).filter((row) => !row._meta?.createdAt).length;
console.log(`filas sin _meta.createdAt: ${sinMeta}`);
socket.close();
process.exit(0);
