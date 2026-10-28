// Verifica que `_aegis/unstable/tools/permissions/set` exista y acepte el payload del modo.
// Crea una sesión desechable, aplica plan, aplica ejecutar (lista vacía) y la borra.
// Uso: node tools/acp-mode-probe.mjs
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
    setTimeout(() => {
      if (pending.delete(rid)) reject(new Error(`${method}: timeout`));
    }, 30000);
  });

await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
await send('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'aegis-web-react-mode-probe', version: '0.1.0' },
});
const { sessionId } = await send('session/new', { cwd: 'C:\\Aegis-Proyects', mcpServers: [] });
console.log(`sesion desechable ${sessionId}`);

const casos = [
  { nombre: 'plan', toolPermissions: [{ toolName: 'shell', permission: 'never_allow' }, { toolName: 'read_file', permission: 'always_allow' }] },
  { nombre: 'revisar', toolPermissions: [{ toolName: 'shell', permission: 'ask_before' }] },
  { nombre: 'ejecutar', toolPermissions: [] },
];
for (const caso of casos) {
  try {
    const out = await send('_aegis/unstable/tools/permissions/set', { sessionId, toolPermissions: caso.toolPermissions });
    const claves = out && typeof out === 'object' ? Object.keys(out).join(',') : typeof out;
    console.log(`${caso.nombre.padEnd(9)} -> ok keys={${claves}}${out?.toolPermissions ? ` aplicadas=${out.toolPermissions.length}` : ''}`);
  } catch (error) {
    console.log(`${caso.nombre.padEnd(9)} -> error ${error.message}`);
  }
}

for (const intento of [
  { method: '_aegis/unstable/tools/permissions/list', params: { sessionId } },
  { method: '_aegis/unstable/tools/permissions/get', params: { sessionId } },
  { method: '_aegis/unstable/session/info', params: { sessionId } },
]) {
  try {
    const out = await send(intento.method, intento.params);
    const resumen = JSON.stringify(out ?? null);
    console.log(`lectura ${intento.method.replace('_aegis/unstable/', '')} -> ${resumen.slice(0, 200)}`);
  } catch (error) {
    console.log(`lectura ${intento.method.replace('_aegis/unstable/', '')} -> sin suerte (${error.message})`);
  }
}

await send('session/delete', { sessionId });
console.log('sesion borrada');
socket.close();
process.exit(0);
