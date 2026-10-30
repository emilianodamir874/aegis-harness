// probe4: reproducir el caso del e2e — modo approve + modelo flash vs flash-max.
// ¿El server pide permiso? ¿El modelo llama a la herramienta?
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0;
const pend = new Map();
let notes = [];
let perm = null;
let autoAnswer = true;
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'session/request_permission') {
    perm = m.params;
    if (autoAnswer) {
      const opt = (m.params.options || []).find((o) => o.optionId === 'allow_once') || (m.params.options || [])[0];
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt?.optionId || 'allow' } } }));
    }
    return;
  }
  if (m.method) notes.push(m);
});
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name: 'probe4', version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });

async function trial(label, model) {
  const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
  if (model) {
    try {
      const r = await req('session/set_config_option', { sessionId: s.sessionId, configId: 'model', value: model });
      const mo = (r.configOptions || []).find((o) => o.id === 'model');
      console.log(`[${label}] modelo ->`, mo ? mo.currentValue : '??');
    } catch (e) { console.log(`[${label}] set model err`, String(e).slice(0, 120)); }
  }
  try {
    const r = await req('session/set_config_option', { sessionId: s.sessionId, configId: 'mode', value: 'approve' });
    const mo = (r.configOptions || []).find((o) => o.id === 'mode');
    console.log(`[${label}] modo ->`, mo ? mo.currentValue : '??');
  } catch (e) { console.log(`[${label}] set mode err`, String(e).slice(0, 120)); }
  notes = []; perm = null;
  const t0 = Date.now();
  const pr = req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Ejecutá exactamente este comando de shell y después respondé LISTO: echo PERM-' + label }] })
    .then((r) => ({ ok: r }), (e) => ({ err: String(e).slice(0, 200) }));
  for (let i = 0; i < 100 && !perm; i++) await sleep(1000);
  const pres = await Promise.race([pr, sleep(90000).then(() => ({ timeout: true }))]);
  const toolCalls = notes.filter((n) => n.params?.update?.sessionUpdate === 'tool_call').length;
  const text = notes.filter((n) => n.params?.update?.sessionUpdate === 'agent_message_chunk').map((n) => n.params.update.content?.text || '').join('');
  console.log(`[${label}] permiso=${perm ? 'SÍ (a los ' + ((Date.now() - t0) / 1000).toFixed(0) + 's)' : 'no'} | tool_calls=${toolCalls} | prompt=${JSON.stringify(pres).slice(0, 140)}`);
  console.log(`[${label}] respuesta: ${text.slice(0, 130).replace(/\n/g, ' ')}`);
  if (perm) console.log(`[${label}] opciones:`, (perm.options || []).map((o) => o.optionId).join(', '));
  await req('session/delete', { sessionId: s.sessionId }).catch(() => {});
}

await trial('A-flash', 'deepseek-v4.1-flash');
await trial('B-flashmax', null); // modelo por defecto del config (flash-max)
ws.close();
process.exit(0);
