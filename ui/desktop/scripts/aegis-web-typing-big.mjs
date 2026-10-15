// Escenario A2: tecleo en móvil (CPU 4x) en una conversación LARGA de verdad, con turno adoptado.
// Copia la sesión más grande vía _aegis/unstable/session/export+import (no ensucia la original).
//   bigQuiet : sesión larga, sin run (costo puro del DOM grande)
//   A        : turno adoptado con el poll de la v6 encendido (session/load + rebuild)
//   B        : mismo turno, mismo DOM, poll apagado (control)
//   D        : Detener desde la pestaña recargada
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const acpUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const rate = Number(process.argv[2] || 4);
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
await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name: 'typing-big', version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });

// copia de una sesión larga: la más grande cuyo export entre por WebSocket (~4 MB)
const list = await req('session/list', {});
const sorted = (list.sessions || []).slice().sort((a, b) => ((b._meta && b._meta.messageCount) || 0) - ((a._meta && a._meta.messageCount) || 0));
out.top3 = sorted.slice(0, 3).map((s) => ({ id: s.sessionId, m: (s._meta && s._meta.messageCount) || 0 }));
out.exportSizes = [];
let exp = null;
for (const c of sorted.slice(0, 6)) {
  let e = null;
  try { e = await req('_aegis/unstable/session/export', { sessionId: c.sessionId, format: 'json' }); } catch (err) { out.exportSizes.push({ id: c.sessionId, err: String(err.message).slice(0, 60) }); continue; }
  out.exportSizes.push({ id: c.sessionId, m: (c._meta && c._meta.messageCount) || 0, bytes: e.data.length });
  stage('export', { id: c.sessionId, m: (c._meta && c._meta.messageCount) || 0, bytes: e.data.length });
  if (e.data.length <= 4000000) { exp = e; out.origen = { id: c.sessionId, msgs: (c._meta && c._meta.messageCount) || 0, bytes: e.data.length }; break; }
}
if (!exp) { console.log(JSON.stringify({ fatal: 'no hay sesión exportable bajo 4 MB', ...out }, null, 1)); process.exit(0); }
let imp = null;
try { imp = await req('_aegis/unstable/session/import', { input: exp.data }, 120000); } catch (err) { console.log(JSON.stringify({ fatal: 'import falló: ' + String(err.message).slice(0, 160), ...out }, null, 1)); process.exit(0); }
const sid = imp.sessionId;
stage('import', { sid, msgs: imp.message_count });
out.copia = { sid, msgs: imp.message_count, title: imp.title };

const br = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Safari/537.36' });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
try { await cdp.send('Emulation.setCPUThrottlingRate', { rate }); out.cpuThrottle = rate; } catch (e) { out.cpuThrottle = 'no-aplicado: ' + String(e.message).slice(0, 60); }

const counts = () => page.evaluate(() => ({ ...window.__aegisWeb.__counts, ...window.__aegisWeb.metrics, nodes: document.querySelectorAll('#msg-inner *').length, msgs: document.querySelectorAll('.msg-a,.msg-user,.tool').length, busy: window.__aegisWeb.state.busy, adopted: window.__aegisWeb.state.adopted }));
const measure = (n, gap) => page.evaluate(async ([n, gap]) => {
  const t = document.querySelector('#input');
  t.focus(); t.value = '';
  await new Promise((r) => requestAnimationFrame(r));
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    t.value += 'q';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(r));
    samples.push(+(performance.now() - t0).toFixed(1));
    if (gap) await new Promise((r) => setTimeout(r, gap));
  }
  return samples;
}, [n, gap]);
const pct = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * q) / 100))] : 0);

const instrument = () => page.evaluate(() => {
  const g = window.__aegisWeb;
  g.__counts = { loads: 0, steers: 0, longTasks: 0, longMs: 0, maxLong: 0 };
  if (!g.__patched) {
    const orig = g.rpc.request.bind(g.rpc);
    g.rpc.request = (m, p) => { if (m === 'session/load') g.__counts.loads++; else if (String(m).includes('steer')) g.__counts.steers++; return orig(m, p); };
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { g.__counts.longTasks++; g.__counts.longMs += Math.round(e.duration); g.__counts.maxLong = Math.max(g.__counts.maxLong, Math.round(e.duration)); } }).observe({ entryTypes: ['longtask'] }); } catch (e) { g.__counts.noLongTask = String(e).slice(0, 80); }
    g.__patched = true;
  }
  g.resetMetrics();
  return true;
});

const windowTest = async (ms) => {
  const c0 = await counts();
  const t0 = Date.now();
  const lat = [];
  while (Date.now() - t0 < ms) lat.push(...(await measure(10, 20)));
  const c1 = await counts();
  return {
    windowMs: Date.now() - t0, keys: lat.length, p50: pct(lat, 50), p95: pct(lat, 95), max: Math.max(...lat),
    loads: c1.loads - c0.loads, steers: c1.steers - c0.steers,
    longTasks: c1.longTasks - c0.longTasks, longMs: c1.longMs - c0.longMs, maxLong: c1.maxLong,
    renders: c1.renders - c0.renders, renderAvgMs: c1.renders - c0.renders ? +((c1.renderMs - c0.renderMs) / (c1.renders - c0.renders)).toFixed(1) : 0, renderMaxMs: +c1.maxRenderMs.toFixed(1),
    composerRuns: c1.composerRuns - c0.composerRuns, composerAvgMs: c1.composerRuns - c0.composerRuns ? +((c1.composerMs - c0.composerMs) / (c1.composerRuns - c0.composerRuns)).toFixed(2) : 0,
    nodeCount: c1.nodes, msgCount: c1.msgs,
  };
};

let promptP = null;
try {
  await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 60000 });
  await page.evaluate((sid) => localStorage.setItem('gweb.last', sid), sid);
  const tReplay = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const g = window.__aegisWeb; return g && g.state.current && !document.querySelector('#status-pill') && document.querySelectorAll('.msg-a,.msg-user,.tool').length > 50; }, null, { timeout: 120000 }).catch(() => {});
  out.replayMs = Date.now() - tReplay;
  stage('replay', { ms: out.replayMs });
  out.trasCargar = await counts();
  stage('trasCargar', out.trasCargar);
  await page.waitForTimeout(4000); // que se asiente el replay
  await instrument();
  out.bigQuiet = await windowTest(15000);
  stage('bigQuiet', out.bigQuiet);

  // arranca el turno largo por ACP crudo en la copia
  const PASOS = 20, SEGS = 3;
  const promptText = `Ejecutá con la herramienta de shell, en orden, estos ${PASOS} comandos, uno por vez, sin pedir permiso y sin explicar nada: ` + Array.from({ length: PASOS }, (_, i) => `(paso ${i + 1}) powershell -NoProfile -Command "Start-Sleep -Seconds ${SEGS}; Write-Output PASO-${i + 1}"`).join(' ; ') + `. Al terminar respondé solamente: FIN-TIPEO.`;
  promptP = req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: promptText }] }).then((r) => (out.prompt = { stopReason: (r && r.stopReason) || null })).catch((e) => (out.promptErr = String(e).slice(0, 200)));
  for (let i = 0; i < 80 && !runId; i++) await new Promise((r) => setTimeout(r, 250));
  out.runId = runId;
  if (!runId) throw new Error('no arrancó el run');

  const tAdopt = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__aegisWeb?.state.busy && window.__aegisWeb.state.adopted, null, { timeout: 30000 }).catch(() => {});
  out.adoptMs = Date.now() - tAdopt;
  stage('adopt', { ms: out.adoptMs });
  await page.waitForFunction(() => { const g = window.__aegisWeb; return g && g.state.current && !document.querySelector('#status-pill') && document.querySelectorAll('.msg-a,.msg-user,.tool').length > 50; }, null, { timeout: 120000 }).catch(() => {});
  await instrument();
  out.A = await windowTest(25000);
  stage('A', out.A);
  await page.evaluate(() => window.__aegisWeb.stopWatch());
  await page.waitForTimeout(1500);
  out.B = await windowTest(25000);
  stage('B', out.B);
  await page.evaluate(() => window.__aegisWeb.startWatch());
  await page.waitForTimeout(2500);
  const td = Date.now();
  await page.evaluate(() => document.querySelector('#runbar-stop')?.click());
  out.D = { detenerMs: await page.waitForFunction(() => !window.__aegisWeb.state.busy, null, { timeout: 30000 }).then(() => Date.now() - td).catch(() => 'timeout-30s') };
  out.D.tras = await counts();
} catch (e) {
  out.fatal = String((e && e.message) || e).slice(0, 300);
}
await Promise.race([promptP || Promise.resolve(), new Promise((r) => setTimeout(r, 90000))]);
out.promptFinal = { runId, stopReason: out.promptErr || (out.prompt && out.prompt.stopReason) || 'sin-respuesta' };
await req('session/delete', { sessionId: sid }).catch(() => {});
ws.close();
await br.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
