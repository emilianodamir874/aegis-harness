// ¿Qué expone session/info DURANTE un turno con herramientas?
// El poll de adopción resincroniza sólo si cambia messageCount|lastMessageAt.
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const acpUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0;
const pend = new Map();
const updates = [];
const ws = new WebSocket(acpUrl);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined) { const f = pend.get(m.id); if (f) { f(m); pend.delete(m.id); } return; }
  if (m.method === 'session/request_permission') {
    const opt = (m.params.options || [])[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
    return;
  }
  if (m.method === 'session/update') {
    const u = (m.params && m.params.update) || {};
    updates.push({ kind: u.sessionUpdate || u.type || '?', meta: u._meta || null });
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { goose: { customNotifications: true } } }, clientInfo: { name: 'info-probe', version: '1' }, _meta: { 'goose/useLoginShellPath': true } });
const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
const sid = s.sessionId;
const p = req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Corré con shell, en orden: (1) powershell -NoProfile -Command "Start-Sleep -Seconds 6; Write-Output A" ; (2) powershell -NoProfile -Command "Start-Sleep -Seconds 6; Write-Output B" ; (3) powershell -NoProfile -Command "Start-Sleep -Seconds 6; Write-Output C". Después respondé solo: OK-PROBE' }] }).then((r) => ({ stopReason: r && r.stopReason })).catch((e) => ({ err: String(e).slice(0, 160) }));

const series = [];
const t0 = Date.now();
for (let i = 0; i < 22 && Date.now() - t0 < 42000; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const info = await req('_goose/unstable/session/info', { sessionId: sid }).catch((e) => ({ error: String(e.message).slice(0, 120) }));
  const meta = (info && info.session && info.session._meta) || {};
  const notif = await req('_goose/unstable/session/steer', { sessionId: sid, prompt: [{ type: 'text', text: '.' }], expectedRunId: 'probe-inexistente' }).then((r) => ({ ok: true, r })).catch((e) => {
    try { return { err: JSON.parse(String(e.message).replace(/^.*?: /, '')).data || null }; } catch { return { err: String(e.message).slice(0, 160) }; }
  });
  series.push({ t: Math.round((Date.now() - t0) / 100) / 10, messageCount: meta.messageCount, lastMessageAt: meta.lastMessageAt, keys: Object.keys(meta).slice(0, 12), steer: notif.err, promptDone: null });
  const done = await Promise.race([p, new Promise((r) => setTimeout(() => r(null), 0))]);
  if (done) { series[series.length - 1].promptDone = done; break; }
}
const fin = await p;
const kinds = {};
for (const u of updates) kinds[u.kind] = (kinds[u.kind] || 0) + 1;
console.log(JSON.stringify({ sid, series, kinds, activos: updates.filter((u) => u.meta && u.meta.goose && u.meta.goose.activeRunId).length, fin }, null, 1));
await req('session/delete', { sessionId: sid }).catch(() => {});
ws.close();
process.exit(0);
