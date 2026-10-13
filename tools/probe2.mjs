// Probe ACP: formas exactas de session/new, session/list, providers/list y
// notificaciones de streaming. Crea una sesión de prueba y la borra al final.
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;

let id = 0;
const pend = new Map();
const notes = [];
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
    return;
  }
  if (m.method === 'session/request_permission') {
    const opt = m.params?.options?.[0]?.optionId ?? 'allow';
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: m.id,
        result: { outcome: { outcome: 'selected', optionId: opt } },
      })
    );
    return;
  }
  if (m.method) notes.push(m);
});
ws.addEventListener('error', () => console.log('WS ERROR'));
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', () => rej(new Error('ws connect failed')));
});

const req = (method, params) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 300))) : res(m.result)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
  });

const init = await req('initialize', {
  protocolVersion: 1,
  clientCapabilities: { _meta: { goose: { customNotifications: true } } },
  clientInfo: { name: 'goose-web-probe', version: '0.1' },
  _meta: { 'goose/useLoginShellPath': true },
});
console.log('== initialize ==');
console.log(
  JSON.stringify(
    { protocolVersion: init.protocolVersion, agentInfo: init.agentInfo, caps: init.agentCapabilities, auth: init.authMethods },
    null,
    1
  ).slice(0, 1600)
);

const ns = await req('session/new', { cwd: 'C:\\Users\\Emiliano', mcpServers: [] });
console.log('\n== session/new (truncado) ==');
console.log(JSON.stringify(ns, null, 1).slice(0, 4000));

const list = await req('session/list', { meta: { goose: { includeLastMessageSnippet: true } } });
console.log('\n== session/list: cantidad =', Array.isArray(list.sessions) ? list.sessions.length : list.sessions);
console.log(JSON.stringify(list.sessions?.slice?.(0, 3) ?? list, null, 1).slice(0, 2600));

try {
  const prov = await req('_goose/unstable/providers/list', {});
  console.log('\n== _goose/unstable/providers/list ==');
  console.log(JSON.stringify(prov, null, 1).slice(0, 4500));
} catch (e) {
  console.log('providers/list err:', String(e).slice(0, 400));
}

notes.length = 0;
const p = await req('session/prompt', {
  sessionId: ns.sessionId,
  prompt: [{ type: 'text', text: 'Responde exactamente: PONG-WEB' }],
});
console.log('\n== prompt result ==');
console.log(JSON.stringify(p).slice(0, 900));

const kinds = {};
for (const n of notes) {
  const u = n.params?.update?.sessionUpdate ?? '(sin update)';
  const k = n.method + ' :: ' + u;
  kinds[k] = (kinds[k] || 0) + 1;
}
console.log('\n== notificaciones recibidas ==');
console.log(JSON.stringify(kinds, null, 1));

const firstChunk = notes.find((n) => n.params?.update?.sessionUpdate === 'agent_message_chunk');
if (firstChunk) {
  console.log('\n== ejemplo agent_message_chunk ==');
  console.log(JSON.stringify(firstChunk.params, null, 1).slice(0, 700));
}
const usage = notes.find((n) => n.params?.update?.sessionUpdate === 'usage_update');
if (usage) {
  console.log('\n== ejemplo usage_update ==');
  console.log(JSON.stringify(usage.params, null, 1).slice(0, 700));
}

try {
  const del = await req('session/delete', { sessionId: ns.sessionId });
  console.log('\nsession/delete ok:', JSON.stringify(del).slice(0, 200));
} catch (e) {
  console.log('delete err:', String(e).slice(0, 200));
}
ws.close();
process.exit(0);
