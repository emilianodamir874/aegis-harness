import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0; const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'ls', version: '1' } });
const { sessions } = await req('session/list', { meta: { aegis: { includeLastMessageSnippet: false } } });
for (const s of sessions.slice(0, 8)) {
  console.log(`${s.sessionId} | "${s.title}" | msgs=${s._meta?.messageCount} | creada=${s._meta?.createdAt} | prov=${s._meta?.providerId}/${s._meta?.modelId}`);
}
ws.close(); process.exit(0);
