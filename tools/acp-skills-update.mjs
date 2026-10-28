// Verifica `sources/update` contra el motor con una skill desechable: crear, actualizar, releer y
// borrar. No toca las skills del operador. Uso: node tools/acp-skills-update.mjs
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
  clientInfo: { name: 'aegis-web-react-skills-update', version: '0.1.0' },
});

const nombre = `zz-update-${Date.now()}`;
const buscar = async () => {
  const list = await send('_aegis/unstable/sources/list', {});
  return (list.sources ?? []).find((source) => source.name === nombre);
};

try {
  const creada = await send('_aegis/unstable/sources/create', {
    type: 'skill',
    name: nombre,
    description: 'sonda de update (usar cuando se pruebe el CRUD)',
    content: `---\nname: ${nombre}\ndescription: sonda de update (usar cuando se pruebe el CRUD)\n---\n\n# Uno\n`,
    target: { scope: 'global' },
  });
  const path = creada?.source?.path ?? (await buscar())?.path;
  console.log(`creada path=${path ?? '?'}`);

  const actualizada = await send('_aegis/unstable/sources/update', {
    type: 'skill',
    path,
    name: nombre,
    description: 'sonda de update EDITADA (usar cuando se pruebe el CRUD)',
    content: `---\nname: ${nombre}\ndescription: sonda de update EDITADA (usar cuando se pruebe el CRUD)\n---\n\n# Dos\n`,
  });
  const claves = actualizada && typeof actualizada === 'object' ? Object.keys(actualizada).join(',') : typeof actualizada;
  console.log(`update: keys={${claves}}`);

  const tras = await buscar();
  const desc = String(tras?.description ?? '');
  const cuerpo = String(tras?.content ?? '');
  console.log(`releida: descripcionEditada=${desc.includes('EDITADA')} contenidoDos=${cuerpo.includes('# Dos')} pathIgual=${tras?.path === path}`);
} catch (error) {
  console.log(`error: ${error.message}`);
} finally {
  const sobrante = await buscar().catch(() => null);
  if (sobrante) {
    try {
      await send('_aegis/unstable/sources/delete', { type: 'skill', path: sobrante.path });
      console.log('limpieza: sonda borrada');
    } catch (error) {
      console.log(`limpieza: ${error.message}`);
    }
  }
  const final = await send('_aegis/unstable/sources/list', {});
  console.log(`skills totales: ${(final.sources ?? []).length}`);
  socket.close();
  process.exit(0);
}
