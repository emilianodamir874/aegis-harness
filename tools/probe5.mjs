// probe5: resetear permiso de 'shell' a ask_before y verificar el flujo de
// permisos en modo approve (allow_once; debe volver a preguntar la 2da vez).
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0;
const pend = new Map();
let perm = null;
const permLog = [];
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'session/request_permission') {
    perm = m.params;
    permLog.push(Date.now());
    const opt = (m.params.options || []).find((o) => o.optionId === 'allow_once') || (m.params.options || [])[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt?.optionId || 'allow' } } }));
    return;
  }
});
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 300))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { goose: { customNotifications: true } } }, clientInfo: { name: 'probe5', version: '1' }, _meta: { 'goose/useLoginShellPath': true } });

// 1) reset del permiso que quedo en always_allow de las pruebas
try {
  for (const permission of ['ask_before', 'askBefore']) {
    try {
      const r = await req('_goose/unstable/tools/permissions/set', { toolPermissions: [{ toolName: 'shell', permission }] });
      console.log('reset shell ->', permission, 'OK', JSON.stringify(r).slice(0, 80));
      break;
    } catch (e) { console.log('reset con', permission, 'fallo:', String(e).slice(0, 140)); }
  }
} catch (e) { console.log('reset err', String(e).slice(0, 200)); }

// 2) sesion nueva, modo approve, dos comandos
const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
const r2 = await req('session/set_config_option', { sessionId: s.sessionId, configId: 'mode', value: 'approve' });
console.log('modo ->', ((r2.configOptions || []).find((o) => o.id === 'mode') || {}).currentValue);

for (const n of [1, 2]) {
  perm = null;
  const pr = req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: `Ejecutá exactamente este comando de shell y después respondé LISTO: echo PERM-${n}` }] })
    .then((r) => ({ ok: r }), (e) => ({ err: String(e).slice(0, 160) }));
  for (let i = 0; i < 90 && !perm; i++) await sleep(1000);
  const pres = await Promise.race([pr, sleep(60000).then(() => ({ timeout: true }))]);
  console.log(`intento ${n}: permiso=${perm ? 'SÍ' : 'no'} | opciones=${perm ? (perm.options || []).map((o) => o.optionId).join(',') : '-'} | prompt=${JSON.stringify(pres).slice(0, 120)}`);
}
console.log('total pedidos de permiso:', permLog.length);
await req('session/delete', { sessionId: s.sessionId }).catch(() => {});
ws.close();
process.exit(0);
