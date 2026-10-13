// Probe: pide el enriquecimiento de titulos y mide si el server manda 'title' en el replay.
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const port = process.argv[2] || '3284';
const sid = process.argv[3] || '20261012_25';
const url = 'ws://' + cfg.publicHost + ':' + port + '/acp?token=' + cfg.secretKey;
let id = 0; const pend = new Map();
let conTitulo = 0, sinTitulo = 0; const ejemplos = []; let fases = [];
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'session/update' && m.params && m.params.update) {
    const u = m.params.update;
    if (u.sessionUpdate === 'tool_call') {
      if (u.title) { conTitulo++; if (ejemplos.length < 6) ejemplos.push({ title: u.title, kind: u.kind || null }); }
      else sinTitulo++;
    }
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 160))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
try {
  const init = await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { goose: { customNotifications: true, toolCallLabelEnrichment: true } } }, clientInfo: { name: 'probe-labels', version: '1' } });
  fases.push('init ok');
  await req('session/load', { sessionId: sid, cwd: cfg.cwd, mcpServers: [] });
  await new Promise((r) => setTimeout(r, 3500));
  console.log(JSON.stringify({ ok: true, puerto: port, sid, conTitulo, sinTitulo, ejemplos, fases }, null, 1));
} catch (e) {
  console.log(JSON.stringify({ ok: false, puerto: port, error: String(e).slice(0, 250), conTitulo, sinTitulo }, null, 1));
}
ws.close(); process.exit(0);
