// v6.2 — verificación del refresco suave en el turno adoptado (sesión larga, móvil, CPU 4x):
//   fase 1 (25 s tecleando): el refresco NO debe tocar el DOM (deferido) y la latencia de
//           tecleo debe quedar igual que con el poll apagado (sin picos).
//   fase 2 (20 s en reposo): el refresco suave debe llegar, costar poco y traer lo nuevo
//           (mensajes/nodos del DOM crecen sin recargar la página).
//   fase 3: Detener + recargar -> la herramienta que quedó sin resultado no gira para siempre.
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
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
const req = (method, params, ms = 90000) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 160))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rej(new Error('timeout ' + ms + 'ms en ' + method)); } }, ms); });
await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name: 'soft-check', version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });

const list = await req('session/list', {});
const sorted = (list.sessions || []).slice().sort((a, b) => ((b._meta && b._meta.messageCount) || 0) - ((a._meta && a._meta.messageCount) || 0));
let exp = null;
for (const c of sorted.slice(0, 6)) {
  let e = null;
  try { e = await req('_aegis/unstable/session/export', { sessionId: c.sessionId, format: 'json' }); } catch { continue; }
  if (e.data.length <= 4000000) { exp = e; out.origen = { id: c.sessionId, msgs: (c._meta && c._meta.messageCount) || 0, bytes: e.data.length }; break; }
}
if (!exp) { console.log(JSON.stringify({ fatal: 'sin sesión exportable <4MB' })); process.exit(0); }
const imp = await req('_aegis/unstable/session/import', { input: exp.data });
const sid = imp.sessionId;
stage('import', { sid, msgs: imp.message_count });

const PASOS = 30, SEGS = 3;
const promptText = `Ejecutá con la herramienta de shell, en orden, estos ${PASOS} comandos, uno por vez, sin pedir permiso y sin explicar nada: ` + Array.from({ length: PASOS }, (_, i) => `(paso ${i + 1}) powershell -NoProfile -Command "Start-Sleep -Seconds ${SEGS}; Write-Output PASO-${i + 1}"`).join(' ; ') + `. Al terminar respondé solamente: FIN-TIPEO.`;
const promptP = req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: promptText }] }).then((r) => (out.prompt = { stopReason: (r && r.stopReason) || null })).catch((e) => (out.promptErr = String(e).slice(0, 160)));
for (let i = 0; i < 80 && !runId; i++) await new Promise((r) => setTimeout(r, 250));
out.runId = runId;
if (!runId) { console.log(JSON.stringify({ fatal: 'no arrancó el run', ...out })); process.exit(0); }

const br = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Safari/537.36' });
const page = await ctx.newPage();
try { await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 }); out.cpuThrottle = 4; } catch (e) { out.cpuThrottle = 'no: ' + String(e.message).slice(0, 40); }

const dbg = () => page.evaluate(() => {
  const g = window.__aegisWeb;
  return {
    watch: { ticks: g.watchDbg.ticks, infos: g.watchDbg.infos, infoErrs: g.watchDbg.infoErrs, keyChanges: g.watchDbg.resyncs, softResyncs: g.watchDbg.softResyncs, softMs: Math.round(g.watchDbg.softMs), maxSoftMs: Math.round(g.watchDbg.maxSoftMs), softDeferred: g.watchDbg.softDeferred, softThrottled: g.watchDbg.softThrottled, interrupted: g.watchDbg.interrupted, lastSoft: g.watchDbg.lastSoft },
    dom: { nodes: document.querySelectorAll('#msg-inner *').length, msgs: document.querySelectorAll('.msg-a,.msg-user,.tool').length },
    busy: g.state.busy, adopted: g.state.adopted,
    longTasks: g.__lt ? g.__lt.n : -1, longMax: g.__lt ? g.__lt.max : -1,
  };
});
const instrument = () => page.evaluate(() => {
  const g = window.__aegisWeb;
  g.__lt = { n: 0, total: 0, max: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { g.__lt.n++; g.__lt.total += Math.round(e.duration); g.__lt.max = Math.max(g.__lt.max, Math.round(e.duration)); } }).observe({ entryTypes: ['longtask'] }); } catch (e) { g.__lt.err = String(e).slice(0, 80); }
  return true;
});
const typeFor = async (ms) => {
  const t0 = Date.now();
  const lat = [];
  while (Date.now() - t0 < ms) {
    lat.push(...(await page.evaluate(async () => {
      const t = document.querySelector('#input');
      t.focus(); t.value = '';
      await new Promise((r) => requestAnimationFrame(r));
      const a = [];
      for (let i = 0; i < 10; i++) { const q = performance.now(); t.value += 'q'; t.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => requestAnimationFrame(r)); a.push(+(performance.now() - q).toFixed(1)); await new Promise((r) => setTimeout(r, 20)); }
      return a;
    })));
  }
  const pct = (q) => lat.slice().sort((x, y) => x - y)[Math.min(lat.length - 1, Math.floor((lat.length * q) / 100))];
  return { ms: Date.now() - t0, keys: lat.length, p50: pct(50), p95: pct(95), max: Math.max(...lat) };
};

try {
  await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 60000 });
  await page.evaluate((sid) => localStorage.setItem('gweb.last', sid), sid);
  const t0 = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__aegisWeb?.state.busy && window.__aegisWeb.state.adopted, null, { timeout: 30000 }).catch(() => {});
  out.adoptMs = Date.now() - t0;
  await page.waitForFunction(() => document.querySelectorAll('.msg-a,.msg-user,.tool').length > 300, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await instrument();
  out.antes = await dbg();
  stage('adoptado', { ms: out.adoptMs, ...out.antes });

  // fase 1: tecleando
  out.fase1 = await typeFor(25000);
  out.fase1.dbg = await dbg();
  stage('fase1-tecleando', out.fase1);

  // fase 2: en reposo (mismo run activo)
  const d0 = await dbg();
  await page.waitForTimeout(20000);
  const d1 = await dbg();
  out.fase2 = { domAntes: d0.dom, domDespues: d1.dom, softResyncs: d1.watch.softResyncs - d0.watch.softResyncs, softMs: d1.watch.softMs - d0.watch.softMs, maxSoftMs: d1.watch.maxSoftMs, lastSoft: d1.watch.lastSoft, longTasks: d1.longTasks, longMax: d1.longMax, keyChanges: d1.watch.keyChanges - d0.watch.keyChanges, softDeferred: d1.watch.softDeferred };
  stage('fase2-reposo', out.fase2);

  // fase 3: Detener + recargar (herramienta sin resultado)
  const td = Date.now();
  await page.evaluate(() => document.querySelector('#runbar-stop')?.click());
  out.detenerMs = await page.waitForFunction(() => !window.__aegisWeb.state.busy, null, { timeout: 30000 }).then(() => Date.now() - td).catch(() => 'timeout-30s');
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.msg-a,.msg-user,.tool').length > 300, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(3000);
  out.fase3 = await page.evaluate(() => ({
    tools: document.querySelectorAll('#msg-inner .tool').length,
    girando: document.querySelectorAll('#msg-inner .tool .spin').length,
    interrumpidas: [...document.querySelectorAll('#msg-inner .tool')].filter((e) => e.classList.contains('err') && e.querySelector('.tint')).length,
    ejemplo: (() => { const e = [...document.querySelectorAll('#msg-inner .tool')].find((x) => x.querySelector('.tint')); return e ? e.querySelector('.tool-title').textContent.trim().slice(0, 90) : null; })(),
  }));
  stage('fase3-interrumpidas', out.fase3);
  out.interruptedGlobal = (await dbg()).watch.interrupted;
  await page.screenshot({ path: 'C:/goose-web/tools/shots/soft-refresh-mobile.png' });
} catch (e) { out.fatal = String((e && e.message) || e).slice(0, 300); }
try { await page.evaluate(() => document.querySelector('#runbar-stop')?.click()); } catch {}
await Promise.race([promptP, new Promise((r) => setTimeout(r, 30000))]);
out.promptFinal = out.promptErr || (out.prompt && out.prompt.stopReason) || 'sin-respuesta';
await req('session/delete', { sessionId: sid }).catch(() => {});
ws.close();
await br.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
