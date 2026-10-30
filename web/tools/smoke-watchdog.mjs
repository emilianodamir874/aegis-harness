import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const port = process.argv[2] || '3391';
const url = 'ws://' + cfg.publicHost + ':' + port + '/acp?token=' + cfg.secretKey;
let id = 0; const pend = new Map(); const tools = []; let text = ''; const t0 = Date.now();
const ws = new WebSocket(url);
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
    const at = ((Date.now() - t0) / 1000).toFixed(1) + 's';
    if (u.sessionUpdate === 'tool_call') tools.push({ t: at, name: u.title || u.kind, status: u.status });
    if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') text += u.content.text;
    if (u.sessionUpdate === 'session_info_update') tools.push({ t: at, name: 'session_info', activeRunId: (u._meta && u._meta.aegis || {}).activeRunId });
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
try {
  await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'smoke-wd', version: '1' } });
  const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
  await req('_aegis/unstable/session/rename', { sessionId: s.sessionId, title: 'zz watchdog test' }).catch(() => {});
  const res = await req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'OBLIGATORIO: usá la herramienta shell para ejecutar literalmente "powershell -NoProfile -Command Start-Sleep -Seconds 25" y esperá a que termine. No lo simules ni respondas antes. Después respondé SOLO: listo.' }] });
  console.log(JSON.stringify({ ok: true, sid: s.sessionId, segundos: ((Date.now() - t0) / 1000).toFixed(1), stopReason: res && res.stopReason, eventos: tools, texto: text.slice(0, 600) }, null, 1));
  try { await req('session/delete', { sessionId: s.sessionId }); } catch {}
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e).slice(0, 400), eventos: tools, texto: text.slice(0, 600) }, null, 1));
}
ws.close(); process.exit(0);
