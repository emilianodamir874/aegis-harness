// Lista las skills de sondeo que quedaron (prefijo zz-probe-) y las borra. Sólo toca esas.
// Uso: node tools/acp-skills-cleanup.mjs [--dry]
import { WebSocket } from 'ws';

const dry = process.argv.includes('--dry');
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
  if (msg.error) slot.reject(new Error(`${msg.error.code}: ${msg.error.message} ${msg.error.data ? JSON.stringify(msg.error.data) : ''}`));
  else slot.resolve(msg.result);
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
  clientInfo: { name: 'aegis-web-react-skills-cleanup', version: '0.1.0' },
});

const list = await send('_aegis/unstable/sources/list', {});
const sondas = (list.sources ?? []).filter((source) => String(source.name ?? '').startsWith('zz-probe-'));
console.log(`sondas encontradas: ${sondas.length} de ${(list.sources ?? []).length} skills`);
for (const sonda of sondas) {
  console.log(`  ${sonda.name} writable=${sonda.writable} path=${sonda.path}`);
  if (dry) continue;
  try {
    const out = await send('_aegis/unstable/sources/delete', { type: 'skill', path: sonda.path });
    console.log(`    borrada keys={${Object.keys(out ?? {}).join(',')}}`);
  } catch (error) {
    console.log(`    error ${error.message}`);
  }
}
const tras = await send('_aegis/unstable/sources/list', {});
const restantes = (tras.sources ?? []).filter((source) => String(source.name ?? '').startsWith('zz-probe-'));
console.log(`quedan sondas: ${restantes.length} · total skills: ${(tras.sources ?? []).length}`);
socket.close();
process.exit(0);
