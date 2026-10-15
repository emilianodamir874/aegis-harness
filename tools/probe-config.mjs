// Inspecciona los configOptions reales de una sesión nueva (chips de la UI).
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0;
const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
});
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pend.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 200))) : res(m.result)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
  });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cfg-probe', version: '1' } });
const ns = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
console.log('sessionId:', ns.sessionId);
for (const o of ns.configOptions || []) {
  console.log(`option id=${JSON.stringify(o.id)} name=${JSON.stringify(o.name)} type=${o.type} current=${JSON.stringify(o.currentValue)} nOptions=${(o.options || []).length}`);
  const names = (o.options || []).slice(0, 8).map((x) => x.name || x.value).join(' | ');
  console.log('   ejemplos:', names);
}
await req('session/delete', { sessionId: ns.sessionId });
ws.close();
process.exit(0);
