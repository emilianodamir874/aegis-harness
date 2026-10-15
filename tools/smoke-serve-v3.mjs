// Smoke del serve v3 (post-swap): sesion + execute_typescript (2+3). Uso: node smoke-serve-v3.mjs [puerto]
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const port = process.argv[2] || '3284';
const url = `ws://${cfg.publicHost}:${port}/acp?token=${cfg.secretKey}`;
let id = 0; const pend = new Map(); const tools = []; let text = ''; let endTurn = null;
const ws = new WebSocket(url);
const t0 = Date.now();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'session/request_permission') {
    const opt = (m.params.options || []).find((o) => o.optionId === 'allow_once') || m.params.options[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
    return;
  }
  if (m.method === 'session/update' && m.params && m.params.update) {
    const u = m.params.update;
    if (u.sessionUpdate === 'tool_call' && u.status !== 'in_progress') tools.push({ t: ((Date.now() - t0) / 1000).toFixed(0) + 's', name: u.title || u.kind });
    if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') text += u.content.text;
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });

try {
  await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'smoke-v3', version: '1' } });
  const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
  await req('_aegis/unstable/session/rename', { sessionId: s.sessionId, title: 'zz smoke cm v3' }).catch(() => {});
  const res = await req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Calculá 2+3 usando la herramienta execute_typescript (no mentalmente) y respondé SOLO el resultado numérico.' }] });
  endTurn = res && res.stopReason;
  try { await req('session/delete', { sessionId: s.sessionId }); } catch {}
  console.log(JSON.stringify({ ok: true, sid: s.sessionId, segundos: ((Date.now() - t0) / 1000).toFixed(0), herramientas: tools, endTurn, texto: text.slice(0, 300) }, null, 1));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e).slice(0, 300), herramientas: tools, texto: text.slice(0, 200) }, null, 1));
}
ws.close(); process.exit(0);
