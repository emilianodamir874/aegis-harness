// Lista los nombres de tools que ve el agente (para armar el perfil de solo lectura).
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
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'tools', version: '1' } });
const nuevo = await req('session/new', { cwd: cfg.cwd || 'C:/Aegis-Proyects', mcpServers: [] });
const lista = await req('_aegis/unstable/tools/list', { sessionId: nuevo.sessionId });
const tools = (lista && (lista.tools || lista)) || [];
const nombres = tools.map((t) => t.name || t.id).filter(Boolean).sort();
console.log(nombres.join('\n'));
try { await req('_aegis/unstable/session/archive', { sessionId: nuevo.sessionId }); } catch (e) {}
ws.close();
process.exit(0);
