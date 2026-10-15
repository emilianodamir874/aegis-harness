// probe6: ¿el cambio de modelo persiste? set -> prompt -> load -> list.
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0;
const pend = new Map();
let notes = [];
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method) notes.push(m);
});
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'probe6', version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });

const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
const modelOf = (r) => ((r.configOptions || []).find((o) => o.id === 'model') || {}).currentValue;
console.log('modelo inicial:', modelOf(s));

const r1 = await req('session/set_config_option', { sessionId: s.sessionId, configId: 'model', value: 'deepseek-v4.1-flash-none' });
console.log('tras set (respuesta):', modelOf(r1));

notes = [];
await req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Responde solo: uno' }] });
const infoUpd = notes.filter((n) => n.params?.update?.sessionUpdate === 'session_info_update');
console.log('session_info_update durante prompt:', infoUpd.length, JSON.stringify(infoUpd[infoUpd.length - 1]?.params || {}).slice(0, 200));

const load = await req('session/load', { sessionId: s.sessionId, cwd: cfg.cwd, mcpServers: [] });
console.log('tras load (persistencia):', modelOf(load));

const list = await req('session/list', { meta: { aegis: { includeLastMessageSnippet: false } } });
const me = (list.sessions || []).find((x) => x.sessionId === s.sessionId);
console.log('session/list meta.modelId:', me && me._meta && me._meta.modelId);

await req('session/delete', { sessionId: s.sessionId }).catch(() => {});
ws.close();
process.exit(0);
