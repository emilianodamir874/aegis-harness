// Escenario A: tecleo en móvil (CPU 4x) con un turno ADOPTADO y el poll de la v6 disparando.
//   ventana A: watch ON  (comportamiento actual: si cambia messageCount -> session/load + rebuild)
//   ventana B: watch OFF (control, misma conversación, mismo run activo)
// Antes se prepara una conversación LARGA en la sesión de prueba, para que el rebuild cueste
// lo que cuesta en la sesión real del teléfono (el run arranca por conexión ACP cruda).
// Después: C) mensaje escrito durante herramienta silenciosa (debe ir como steer)
//           D) Detener desde la pestaña recargada (busy -> false, stopReason cancelled)
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const acpUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const rate = Number(process.argv[2] || 4);
const out = {};
let id = 0;
const pend = new Map();
let runId = null;
const ws = new WebSocket(acpUrl);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined) {
    const f = pend.get(m.id);
    if (f) { f(m); pend.delete(m.id); }
    return;
  }
  if (m.method === 'session/request_permission') {
    const opt = (m.params.options || [])[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
    return;
  }
  const meta = m.params && m.params.update && m.params.update._meta;
  if (meta && meta.aegis && meta.aegis.activeRunId) runId = meta.aegis.activeRunId;
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
  });

await req('initialize', {
  protocolVersion: 1,
  clientCapabilities: { _meta: { aegis: { customNotifications: true } } },
  clientInfo: { name: 'typing-adopt', version: '1' },
  _meta: { 'aegis/useLoginShellPath': true },
});
const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
const sid = s.sessionId;
out.sid = sid;

// 1) conversación larga de verdad (pocas rondas, mucho texto) para que el rebuild cueste
const tPrep = Date.now();
const pre = await req('session/prompt', {
  sessionId: sid,
  prompt: [{ type: 'text', text: 'Escribí cuatro párrafos de unas 500 palabras cada uno sobre la historia del pan, seguidos, sin títulos ni listas. Empezá ya.' }],
}).then((r) => ({ stopReason: r && r.stopReason })).catch((e) => ({ err: String(e).slice(0, 160) }));
out.preparacion = { ms: Date.now() - tPrep, ...pre };

// 2) turno largo y silencioso (20 herramientas de shell de 3 s) que arranca por ACP crudo
const PASOS = 20, SEGS = 3;
const promptText =
  `Ejecutá con la herramienta de shell, en orden, estos ${PASOS} comandos, uno por vez, sin pedir permiso y sin explicar nada: ` +
  Array.from({ length: PASOS }, (_, i) => `(paso ${i + 1}) powershell -NoProfile -Command "Start-Sleep -Seconds ${SEGS}; Write-Output PASO-${i + 1}"`).join(' ; ') +
  `. Al terminar los ${PASOS}, respondé solamente: FIN-TIPEO.`;
const promptP = req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: promptText }] })
  .then((r) => (out.prompt = { stopReason: (r && r.stopReason) || null }))
  .catch((e) => (out.promptErr = String(e).slice(0, 200)));

for (let i = 0; i < 80 && !runId; i++) await new Promise((r) => setTimeout(r, 250));
out.runId = runId;
if (!runId) {
  console.log(JSON.stringify({ fatal: 'no arrancó el run', ...out }, null, 1));
  process.exit(0);
}

const br = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await br.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Safari/537.36',
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
try { await cdp.send('Emulation.setCPUThrottlingRate', { rate }); out.cpuThrottle = rate; } catch (e) { out.cpuThrottle = 'no-aplicado: ' + String(e.message).slice(0, 60); }

const snap = () =>
  page.evaluate(() => ({
    busy: window.__aegisWeb.state.busy,
    adopted: window.__aegisWeb.state.adopted,
    runId: window.__aegisWeb.state.runId,
    msgs: document.querySelectorAll('.msg-a,.msg-user,.tool').length,
    nodes: document.querySelectorAll('#msg-inner *').length,
    runbar: (() => { const x = document.querySelector('#runbar'); return !x || x.hidden ? null : { text: x.querySelector('#runbar-text').textContent, time: x.querySelector('#runbar-time').textContent, stop: !x.querySelector('#runbar-stop').hidden }; })(),
    steerNotes: [...document.querySelectorAll('.steer-note')].map((e) => e.textContent).slice(-2),
  }));

const counts = () => page.evaluate(() => ({ ...window.__aegisWeb.__counts, ...window.__aegisWeb.metrics }));

const measure = (n, gap) =>
  page.evaluate(
    async ([n, gap]) => {
      const t = document.querySelector('#input');
      t.focus();
      t.value = '';
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
    },
    [n, gap]
  );

const pct = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * q) / 100))] : 0);

// Teclea de forma continua durante `ms` y agrega latencias + contadores del período.
const windowTest = async (ms) => {
  const c0 = await counts();
  const t0 = Date.now();
  const lat = [];
  while (Date.now() - t0 < ms) lat.push(...(await measure(10, 20)));
  const c1 = await counts();
  const w = Date.now() - t0;
  return {
    windowMs: w,
    keys: lat.length,
    p50: pct(lat, 50), p95: pct(lat, 95), max: Math.max(...lat),
    loads: c1.loads - c0.loads,
    steers: c1.steers - c0.steers,
    longTasks: c1.longTasks - c0.longTasks,
    longMs: c1.longMs - c0.longMs,
    maxLong: c1.maxLong,
    renders: c1.renders - c0.renders,
    renderAvgMs: c1.renders - c0.renders ? +((c1.renderMs - c0.renderMs) / (c1.renders - c0.renders)).toFixed(1) : 0,
    renderMaxMs: +c1.maxRenderMs.toFixed(1),
    composerRuns: c1.composerRuns - c0.composerRuns,
    composerAvgMs: c1.composerRuns - c0.composerRuns ? +((c1.composerMs - c0.composerMs) / (c1.composerRuns - c0.composerRuns)).toFixed(2) : 0,
    composerMaxMs: +c1.maxComposerMs.toFixed(2),
    domNodes: await page.evaluate(() => document.querySelectorAll('#msg-inner *').length),
  };
};

try {
  await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 60000 });
  await page.evaluate((sid) => localStorage.setItem('gweb.last', sid), sid);
  const t0 = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  out.adoptMs = await page
    .waitForFunction(() => window.__aegisWeb?.state.busy && window.__aegisWeb.state.adopted, null, { timeout: 25000 })
    .then(() => Date.now() - t0)
    .catch(() => 'timeout-25s');
  out.trasRecarga = await snap();

  await page.evaluate(() => {
    const g = window.__aegisWeb;
    g.__counts = { loads: 0, steers: 0, longTasks: 0, longMs: 0, maxLong: 0 };
    const orig = g.rpc.request.bind(g.rpc);
    g.rpc.request = (m, p) => {
      if (m === 'session/load') g.__counts.loads++;
      else if (String(m).includes('steer')) g.__counts.steers++;
      return orig(m, p);
    };
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) { g.__counts.longTasks++; g.__counts.longMs += Math.round(e.duration); g.__counts.maxLong = Math.max(g.__counts.maxLong, Math.round(e.duration)); } }).observe({ entryTypes: ['longtask'] });
    } catch (e) { g.__counts.noLongTask = String(e).slice(0, 100); }
    g.resetMetrics();
  });

  // ventana A: watch ON (v6 actual)
  out.A = await windowTest(25000);
  out.A.tras = await snap();

  // ventana B: watch OFF (control). La conversación se deja como está: mismo DOM, mismo run.
  await page.evaluate(() => window.__aegisWeb.stopWatch());
  await page.waitForTimeout(1500);
  out.B = await windowTest(25000);
  out.B.tras = await snap();
  await page.evaluate(() => window.__aegisWeb.startWatch());
  await page.waitForTimeout(2600);

  // ventana C: mensaje escrito en el medio de una herramienta silenciosa
  out.C = { antes: await snap() };
  const marca = 'INDICACION-TIPEO ' + Date.now().toString().slice(-5);
  out.C.marca = marca;
  await page.evaluate((txt) => { const t = document.querySelector('#input'); t.value = txt; t.dispatchEvent(new Event('input', { bubbles: true })); }, marca + ': avisá que recibiste esto y seguí.');
  await page.evaluate(() => document.querySelector('#btn-send').click());
  await page.waitForTimeout(1500);
  out.C.despuesDeEnviar = await snap();

  // ventana D: Detener desde la pestaña recargada
  const td = Date.now();
  await page.evaluate(() => document.querySelector('#runbar-stop')?.click());
  out.D = { detenerMs: await page.waitForFunction(() => !window.__aegisWeb.state.busy, null, { timeout: 30000 }).then(() => Date.now() - td).catch(() => 'timeout-30s') };
  out.D.trasDetener = await snap();
  out.D.runbar = await page.evaluate(() => { const x = document.querySelector('#runbar'); return x && !x.hidden ? { text: x.querySelector('#runbar-text').textContent, stop: !x.querySelector('#runbar-stop').hidden } : null; });
  await page.screenshot({ path: 'C:/goose-web/tools/shots/typing-adopt-mobile.png' });
} catch (e) {
  out.fatal = String((e && e.message) || e).slice(0, 300);
}

await Promise.race([promptP, new Promise((r) => setTimeout(() => r('timeout'), 90000))]);
out.promptFinal = { runId, stopReason: out.promptErr || (out.prompt && out.prompt.stopReason) || 'sin-respuesta' };
await req('session/delete', { sessionId: sid }).catch(() => {});
ws.close();
await br.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
