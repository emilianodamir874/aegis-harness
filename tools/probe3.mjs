// probe3: formas que faltan — session/load, permisos (modo approve),
// session_info_update, prompt con imagen. Borra todas las sesiones al final.
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const PNG = 'C:/aegis-web/tools/test-red.png';

let id = 0;
const pend = new Map();
let notes = [];
let permParams = null;
let shouldAnswerPermission = false;
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
    return;
  }
  if (m.method === 'session/request_permission') {
    permParams = m.params;
    if (shouldAnswerPermission) {
      const opt = (m.params.options || []).find((o) => /allow/.test(o.optionId)) || (m.params.options || [])[0];
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt?.optionId || 'allow' } } }));
    }
    return;
  }
  if (m.method) notes.push(m);
});
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 240))) : res(m.result)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await req('initialize', {
  protocolVersion: 1,
  clientCapabilities: { _meta: { aegis: { customNotifications: true } } },
  clientInfo: { name: 'probe3', version: '1' },
  _meta: { 'aegis/useLoginShellPath': true },
});

// ---------- 1) session/load: que devuelve y que replay emite ----------
const s1 = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
await req('session/prompt', { sessionId: s1.sessionId, prompt: [{ type: 'text', text: 'Responde solo: uno' }] });
notes = [];
const load = await req('session/load', { sessionId: s1.sessionId, cwd: cfg.cwd, mcpServers: [] });
console.log('== session/load result keys ==');
console.log(JSON.stringify(load, null, 1).slice(0, 1200));
const loadKinds = {};
for (const n of notes) loadKinds[n.method + ' :: ' + (n.params?.update?.sessionUpdate || '?')] = (loadKinds[n.method + ' :: ' + (n.params?.update?.sessionUpdate || '?')] || 0) + 1;
console.log('replay durante load:', JSON.stringify(loadKinds));
await req('session/delete', { sessionId: s1.sessionId });

// ---------- 2) permisos con modo approve ----------
const s2 = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
console.log('\n== set_config_option (todos los intentos) ==');
for (const params of [
  { sessionId: s2.sessionId, configId: 'mode', value: 'approve' },
  { sessionId: s2.sessionId, optionId: 'mode', value: 'approve' },
  { sessionId: s2.sessionId, id: 'mode', value: 'approve' },
]) {
  try {
    const r = await req('session/set_config_option', params);
    console.log('OK con', Object.keys(params).join(','), '->', JSON.stringify(r).slice(0, 200));
    break;
  } catch (e) {
    console.log('fallo con', Object.keys(params).join(','), '->', String(e).slice(0, 200));
  }
}

notes = [];
permParams = null;
shouldAnswerPermission = true;
let permPrompt = null;
const promptPromise = req('session/prompt', {
  sessionId: s2.sessionId,
  prompt: [{ type: 'text', text: 'Usá la herramienta de shell para ejecutar exactamente: echo PERM-TEST' }],
}).then((r) => ({ ok: r }), (e) => ({ err: String(e) }));
// espera hasta 90s a que aparezca el pedido de permiso
for (let i = 0; i < 90 && !permParams; i++) await sleep(1000);
if (permParams) {
  console.log('\n== request_permission params ==');
  console.log(JSON.stringify(permParams, null, 1).slice(0, 2000));
} else {
  console.log('\n(no llego request_permission en 90s)');
}
const pres = await Promise.race([promptPromise, sleep(120000).then(() => ({ timeout: true }))]);
console.log('prompt (approve) ->', JSON.stringify(pres).slice(0, 400));
const infoUpd = notes.find((n) => n.params?.update?.sessionUpdate === 'session_info_update');
if (infoUpd) {
  console.log('\n== ejemplo session_info_update ==');
  console.log(JSON.stringify(infoUpd.params, null, 1).slice(0, 1200));
}
await req('session/delete', { sessionId: s2.sessionId });

// ---------- 3) prompt con imagen ----------
const pngB64 = (await readFile(PNG)).toString('base64');
const s3 = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
notes = [];
try {
  const r3 = await req('session/prompt', {
    sessionId: s3.sessionId,
    prompt: [
      { type: 'text', text: '¿De qué color sólido es esta imagen? Responde una sola palabra.' },
      { type: 'image', mimeType: 'image/png', data: pngB64 },
    ],
  });
  console.log('\n== prompt con imagen -> OK ==', JSON.stringify(r3).slice(0, 300));
  const texts = notes.filter((n) => n.params?.update?.sessionUpdate === 'agent_message_chunk').map((n) => n.params.update.content?.text || '').join('');
  console.log('respuesta:', texts.slice(0, 200));
} catch (e) {
  console.log('\n== prompt con imagen -> FALLO ==', String(e).slice(0, 400));
}
await req('session/delete', { sessionId: s3.sessionId });

ws.close();
process.exit(0);
