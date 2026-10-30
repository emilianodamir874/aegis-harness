// Diagnóstico: export/import por WebSocket (¿límite de tamaño de frame o algo más?)
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const acpUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0;
const pend = new Map();
const log = [];
const ws = new WebSocket(acpUrl);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  log.push('msg ' + (m.method || ('id=' + m.id)) + ' bytes=' + String(ev.data).length);
  if (m.id !== undefined && m.method === undefined) { const f = pend.get(m.id); if (f) { f(m); pend.delete(m.id); } }
});
ws.addEventListener('close', (e) => log.push('CLOSE code=' + e.code + ' reason=' + e.reason));
ws.addEventListener('error', () => log.push('ERROR'));
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params, ms = 60000) => new Promise((res, rej) => {
  const mid = ++id;
  pend.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 200))) : res(m.result)));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
  setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rej(new Error('timeout ' + ms + 'ms')); } }, ms);
});
await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name: 'io-probe', version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });
const list = await req('session/list', {});
const sorted = (list.sessions || []).slice().sort((a, b) => ((b._meta && b._meta.messageCount) || 0) - ((a._meta && a._meta.messageCount) || 0));
const res = { n: sorted.length, top3: sorted.slice(0, 3).map((s) => ({ id: s.sessionId, m: (s._meta && s._meta.messageCount) || 0 })) };
const big = sorted[0];
try {
  const exp = await req('_aegis/unstable/session/export', { sessionId: big.sessionId, format: 'json' });
  res.exportBytes = exp.data.length;
} catch (e) { res.exportErr = String(e.message).slice(0, 200); }
const small = sorted[sorted.length - 1];
try {
  const e2 = await req('_aegis/unstable/session/export', { sessionId: small.sessionId, format: 'json' });
  res.smallExportBytes = e2.data.length;
  const imp = await req('_aegis/unstable/session/import', { input: e2.data }, 30000);
  res.smallImport = { sid: imp.sessionId, msgs: imp.message_count };
  await req('session/delete', { sessionId: imp.sessionId });
} catch (e) { res.smallErr = String(e.message).slice(0, 200); }
res.log = log.slice(-12);
console.log(JSON.stringify(res, null, 1));
try { ws.close(); } catch {}
process.exit(0);
