// Imprime la forma real de sources/create, update y delete trabajando sobre una skill DESECHABLE
// (nombre con prefijo `zz-probe-`), que se borra al final. No toca las 41 skills del operador.
// Uso: node tools/acp-skills-probe.mjs
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
  clientInfo: { name: 'aegis-web-react-skills-probe', version: '0.1.0' },
});

const name = `zz-probe-${Date.now()}`;
const list = await send('_aegis/unstable/sources/list', {});
const primero = (list.sources ?? [])[0] ?? {};
console.log(`list: ${(list.sources ?? []).length} sources, claves={${Object.keys(primero).join(',')}}`);

const crear = await send('_aegis/unstable/sources/create', {
  type: 'skill',
  name,
  description: 'skill desechable de sondeo (usar cuando se pruebe el CRUD)',
  body: '# Sonda\n\nContenido de prueba.\n',
});
console.log(`create: keys={${Object.keys(crear ?? {}).join(',')}} name=${crear?.name ?? ''}`);

const trasCrear = await send('_aegis/unstable/sources/list', {});
const encontrada = (trasCrear.sources ?? []).find((source) => source.name === name);
console.log(`aparece en list: ${Boolean(encontrada)} description=${String(encontrada?.description ?? '').slice(0, 60)}`);

try {
  const update = await send('_aegis/unstable/sources/update', {
    type: 'skill',
    path: encontrada?.path,
    name,
    description: 'skill desechable editada por el sondeo',
    content: '# Sonda editada`n',
  });
  console.log(`update: keys={${Object.keys(update ?? {}).join(',')}}`);
} catch (error) {
  console.log(`update: error ${error.message}`);
}

try {
  const borrar = await send('_aegis/unstable/sources/delete', { type: 'skill', path: encontrada?.path });
  console.log(`delete: keys={${Object.keys(borrar ?? {}).join(',')}}`);
} catch (error) {
  console.log(`delete: error ${error.message}`);
}
const trasBorrar = await send('_aegis/unstable/sources/list', {});
const sigue = (trasBorrar.sources ?? []).some((source) => source.name === name);
console.log(`tras borrar: ${(trasBorrar.sources ?? []).length} sources, sigue la sonda=${sigue}`);

socket.close();
process.exit(0);
