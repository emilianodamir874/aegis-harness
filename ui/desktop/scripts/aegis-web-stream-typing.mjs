// Latencia de tecleo en móvil, con CPU limitada 4x (proxy del teléfono real):
//   reposo (sesión larga)  vs  streaming de una respuesta larga  vs  recién terminado
// Mide tecla->frame, long tasks del main thread y el costo real del render (window.__aegisWeb.metrics).
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const url = process.argv[2] || 'http://127.0.0.1:3788/';
const rate = Number(process.argv[3] || 4);
const out = {};
const LONG_PROMPT = cfg.longPrompt || 'Escribí un ensayo de 1200 palabras sobre la historia del pan, en párrafos seguidos (sin listas, sin títulos, sin negritas). Empezá ya.';

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
try { await cdp.send('Emulation.setCPUThrottlingRate', { rate }); out.cpuThrottle = rate; } catch (e) { out.cpuThrottle = 'no-aplicado: ' + String(e.message).slice(0, 80); }

const instrument = () =>
  page.evaluate(() => {
    const g = window.__aegisWeb;
    g.__lt = { n: 0, total: 0, max: 0 };
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) { g.__lt.n++; g.__lt.total += Math.round(e.duration); g.__lt.max = Math.max(g.__lt.max, Math.round(e.duration)); } }).observe({ entryTypes: ['longtask'] });
    } catch (e) { g.__lt.err = String(e).slice(0, 100); }
    g.resetMetrics();
    return true;
  });

const measure = (n, gap) =>
  page.evaluate(
    async ([n, gap]) => {
      const t = document.querySelector('#input');
      const lt0 = { ...window.__aegisWeb.__lt };
      const m0 = { ...window.__aegisWeb.metrics };
      t.focus();
      t.value = '';
      await new Promise((r) => requestAnimationFrame(r));
      const lat = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        t.value += 'q';
        t.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => requestAnimationFrame(r));
        lat.push(+(performance.now() - t0).toFixed(1));
        if (gap) await new Promise((r) => setTimeout(r, gap));
      }
      const m1 = { ...window.__aegisWeb.metrics };
      const lt = window.__aegisWeb.__lt;
      const p = (q) => lat.slice().sort((x, y) => x - y)[Math.min(lat.length - 1, Math.floor((lat.length * q) / 100))] || 0;
      return {
        keys: n,
        p50: p(50), p95: p(95), max: Math.max(...lat),
        longTasks: lt.n - lt0.n, longMax: lt.max,
        renders: m1.renders - m0.renders,
        renderAvgMs: m1.renders - m0.renders ? +(((m1.renderMs - m0.renderMs) / (m1.renders - m0.renders))).toFixed(1) : 0,
        renderMaxMs: +m1.maxRenderMs.toFixed(1),
        composerRuns: m1.composerRuns - m0.composerRuns,
        composerAvgMs: m1.composerRuns - m0.composerRuns ? +((m1.composerMs - m0.composerMs) / (m1.composerRuns - m0.composerRuns)).toFixed(2) : 0,
        composerMaxMs: +m1.maxComposerMs.toFixed(2),
        domNodes: document.querySelectorAll('#msg-inner *').length,
      };
    },
    [n, gap]
  );

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.sb-item').length > 0, null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(600);
  await instrument();

  // ---------- reposo: sesión más larga disponible ----------
  const big = await page.evaluate(() => {
    const s = window.__aegisWeb.state.sessions.slice().sort((a, b) => (b._meta?.messageCount || 0) - (a._meta?.messageCount || 0))[0];
    return s ? { id: s.sessionId, n: s._meta?.messageCount || 0 } : null;
  });
  out.bigSession = big;
  if (big) {
    await page.evaluate((id) => document.querySelector(`.sb-row[data-id="${id}"] .sb-item`)?.click(), big.id);
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => !document.querySelector('#status-pill'), null, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(1500);
    out.reposo = await measure(40, 25);
    await instrument();
  }

  // ---------- streaming: chat nuevo con respuesta larga ----------
  await page.evaluate(() => document.querySelector('#btn-new').click());
  await page.waitForTimeout(2500);
  await page.fill('#input', LONG_PROMPT);
  await page.evaluate(() => document.querySelector('#btn-send').click());
  await page.waitForFunction(() => window.__aegisWeb.state.busy, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.msg-a.streaming'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await instrument();
  out.streaming1 = await measure(40, 20);
  out.streaming2 = await measure(200, 20); // ~10 s tecleando sin parar mientras el texto crece
  out.streaming3 = await measure(40, 25);
  await page.screenshot({ path: 'C:/aegis-web/tools/shots/stream-typing-mobile.png' });

  // ---------- control: mismo chat, ya sin streaming ----------
  await page.waitForFunction(() => !window.__aegisWeb.state.busy, null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await instrument();
  out.trasTerminar = await measure(40, 25);
} catch (e) {
  out.fatal = String((e && e.message) || e).slice(0, 300);
}
await br.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
