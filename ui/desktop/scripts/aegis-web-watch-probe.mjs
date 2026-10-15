// ¿Por qué la ventana A no mostró session/load? Trazas del poll de adopción en una sesión
// larga (copia importada) con un turno real corriendo: ticks, session/info, messageCount
// y resyncs efectivos. Además mide el costo de cada resync (performance.now alrededor).
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const acpUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const out = {};
const stage = (k, v) => console.log('STAGE ' + k + ' ' + JSON.stringify(v));
let id = 0;
const pend = new Map();
let runId = null;
const ws = new WebSocket(acpUrl);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined) { const f = pend.get(m.id); if (f) { f(m); pend.delete(m.id); } return; }
  if (m.method === 'session/request_permission') {
    const opt = (m.params.options || [])[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
    return;
  }
  const meta = m.params && m.params.update && m.params.update._meta;
  if (meta && meta.aegis && meta.aegis.activeRunId) runId = meta.aegis.activeRunId;
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params, ms = 90000) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rej(new Error('timeout ' + ms + 'ms en ' + method)); } }, ms); });
await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name: 'watch-probe', version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });

const list = await req('session/list', {});
const sorted = (list.sessions || []).slice().sort((a, b) => ((b._meta && b._meta.messageCount) || 0) - ((a._meta && a._meta.messageCount) || 0));
let exp = null;
for (const c of sorted.slice(0, 6)) {
  let e = null;
  try { e = await req('_aegis/unstable/session/export', { sessionId: c.sessionId, format: 'json' }); } catch { continue; }
  stage('export', { id: c.sessionId, m: (c._meta && c._meta.messageCount) || 0, bytes: e.data.length });
  if (e.data.length <= 4000000) { exp = e; out.origen = { id: c.sessionId, msgs: (c._meta && c._meta.messageCount) || 0, bytes: e.data.length }; break; }
}
if (!exp) { console.log(JSON.stringify({ fatal: 'sin sesión exportable <4MB' })); process.exit(0); }
const imp = await req('_aegis/unstable/session/import', { input: exp.data });
const sid = imp.sessionId;
stage('import', { sid, msgs: imp.message_count });

const PASOS = 24, SEGS = 3;
const promptText = `Ejecutá con la herramienta de shell, en orden, estos ${PASOS} comandos, uno por vez, sin pedir permiso y sin explicar nada: ` + Array.from({ length: PASOS }, (_, i) => `(paso ${i + 1}) powershell -NoProfile -Command "Start-Sleep -Seconds ${SEGS}; Write-Output PASO-${i + 1}"`).join(' ; ') + `. Al terminar respondé solamente: FIN-TIPEO.`;
const promptP = req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: promptText }] }).then((r) => (out.prompt = { stopReason: (r && r.stopReason) || null })).catch((e) => (out.promptErr = String(e).slice(0, 200)));
for (let i = 0; i < 80 && !runId; i++) await new Promise((r) => setTimeout(r, 250));
out.runId = runId;
if (!runId) { console.log(JSON.stringify({ fatal: 'no arrancó el run', ...out })); process.exit(0); }

const br = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Safari/537.36' });
const page = await ctx.newPage();
try { await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 }); out.cpuThrottle = 4; } catch (e) { out.cpuThrottle = 'no: ' + String(e.message).slice(0, 40); }
try {
  await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 60000 });
  await page.evaluate((sid) => localStorage.setItem('gweb.last', sid), sid);
  const t0 = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__aegisWeb?.state.busy && window.__aegisWeb.state.adopted, null, { timeout: 30000 }).catch(() => {});
  out.adoptMs = Date.now() - t0;
  await page.waitForFunction(() => document.querySelectorAll('.msg-a,.msg-user,.tool').length > 300, null, { timeout: 120000 }).catch(() => {});
  stage('adoptado', { adoptMs: out.adoptMs });
  // teclea 45 s mientras el turno hace herramientas: ¿el poll resincroniza?
  const t1 = Date.now();
  const lat = [];
  while (Date.now() - t1 < 45000) {
    const s2 = await page.evaluate(async () => {
      const t = document.querySelector('#input');
      t.focus(); t.value = '';
      await new Promise((r) => requestAnimationFrame(r));
      const a = [];
      for (let i = 0; i < 10; i++) { const q = performance.now(); t.value += 'q'; t.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => requestAnimationFrame(r)); a.push(+(performance.now() - q).toFixed(1)); await new Promise((r) => setTimeout(r, 20)); }
      return a;
    });
    lat.push(...s2);
  }
  const pct = (a, q) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * q) / 100))];
  out.ventana = { ms: Date.now() - t1, keys: lat.length, p50: pct(lat, 50), p95: pct(lat, 95), max: Math.max(...lat) };
  out.watch = await page.evaluate(() => ({ ...window.__aegisWeb.watchDbg, keys: window.__aegisWeb.watchDbg.keys.slice(-20).map((k) => k.key) }));
  out.metrics = await page.evaluate(() => ({ ...window.__aegisWeb.metrics }));
  out.dom = await page.evaluate(() => ({ nodes: document.querySelectorAll('#msg-inner *').length, msgs: document.querySelectorAll('.msg-a,.msg-user,.tool').length }));
  stage('ventana', out.ventana);
  stage('watch', { ticks: out.watch.ticks, infos: out.watch.infos, infoErrs: out.watch.infoErrs, resyncs: out.watch.resyncs, resyncMs: Math.round(out.watch.resyncMs), maxResyncMs: Math.round(out.watch.maxResyncMs) });
} catch (e) { out.fatal = String((e && e.message) || e).slice(0, 300); }
try { await page.evaluate(() => document.querySelector('#runbar-stop')?.click()); } catch {}
await Promise.race([promptP, new Promise((r) => setTimeout(r, 30000))]);
out.promptFinal = out.promptErr || (out.prompt && out.prompt.stopReason) || 'sin-respuesta';
await req('session/delete', { sessionId: sid }).catch(() => {});
ws.close();
await br.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
