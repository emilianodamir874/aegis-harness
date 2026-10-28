// Prueba variantes del payload de sources/create para saber qué acepta el motor, y limpia lo que cree.
// No toca las skills existentes: usa nombres con prefijo zz-probe-.
// Uso: node tools/acp-skills-create-probe.mjs
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
  if (msg.error) {
    const detalle = msg.error.data ? ` data=${JSON.stringify(msg.error.data)}` : '';
    slot.reject(new Error(`${msg.error.code}: ${msg.error.message}${detalle}`));
  } else slot.resolve(msg.result);
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
  clientInfo: { name: 'aegis-web-react-skills-create-probe', version: '0.1.0' },
});

const base = (name) => ({
  type: 'skill',
  name,
  description: 'sonda desechable (usar cuando se pruebe el CRUD de skills)',
  content: `---\nname: ${name}\ndescription: sonda desechable (usar cuando se pruebe el CRUD de skills)\n---\n\n# Sonda\n\nContenido.\n`,
});

const variantes = [
  { etiqueta: 'target.scope=global', params: (name) => ({ ...base(name), target: { scope: 'global' } }) },
  { etiqueta: 'sin target', params: (name) => base(name) },
  { etiqueta: 'content objeto', params: (name) => ({ ...base(name), content: { body: '# Sonda' }, target: { scope: 'global' } }) },
];

for (const [indice, variante] of variantes.entries()) {
  const name = `zz-probe-${Date.now()}-${indice}`;
  try {
    const out = await send('_aegis/unstable/sources/create', variante.params(name));
    console.log(`${variante.etiqueta.padEnd(22)} -> ok keys={${Object.keys(out ?? {}).join(',')}} name=${out?.name ?? '?'}`);
    try {
      await send('_aegis/unstable/sources/delete', { type: 'skill', path: out?.path ?? '' });
      console.log(`${' '.repeat(22)}    limpieza: borrada por path`);
    } catch (error) {
      console.log(`${' '.repeat(22)}    limpieza: ${error.message}`);
    }
  } catch (error) {
    console.log(`${variante.etiqueta.padEnd(22)} -> error ${error.message}`);
  }
}

socket.close();
process.exit(0);
