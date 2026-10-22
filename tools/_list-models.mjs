// Lista los modelos que ofrece el proveedor activo (configOptions de una sesion nueva).
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const wsUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0;
const pend = new Map();
const ws = new WebSocket(wsUrl);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) => new Promise((res, rej) => {
  const mid = ++id;
  pend.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
});
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'models', version: '1' } });
const nuevo = await req('session/new', { cwd: cfg.cwd || 'C:/Aegis-Proyects', mcpServers: [] });
const sid = nuevo.sessionId;
for (const opt of nuevo.configOptions || []) {
  console.log('--- ' + opt.id + ' = ' + JSON.stringify(opt.currentValue));
  for (const o of opt.options || []) console.log('    ' + JSON.stringify(o.value) + '  ' + (o.name || ''));
}
try { await req('_aegis/unstable/session/archive', { sessionId: sid }); console.log('sesion de prueba archivada'); } catch (e) { console.log('aviso archivo: ' + e.message); }
ws.close();
process.exit(0);
