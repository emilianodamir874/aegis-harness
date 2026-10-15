// Humo v6.3: la app publicada arranca, el renderer nuevo aguanta un replay grande y no hay errores.
import { chromium } from '@playwright/test';
const br = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 60000 });
await page.waitForFunction(() => (window.__aegisWeb?.state.sessions || []).length > 0, null, { timeout: 60000 });
const big = await page.evaluate(() => {
  const s = [...window.__aegisWeb.state.sessions].sort((a, b) => ((b._meta?.messageCount) || 0) - ((a._meta?.messageCount) || 0))[0];
  const sid = s && (s.sessionId || s.id);
  if (sid) localStorage.setItem('gweb.last', sid);
  return s ? { id: sid, msgs: s._meta?.messageCount || 0 } : null;
});
await page.reload({ waitUntil: 'domcontentloaded' });
const t0 = Date.now();
await page.waitForFunction((n) => document.querySelectorAll('.msg-a,.msg-user,.tool').length > Math.min(300, n * 0.9), big ? big.msgs : 300, { timeout: 180000 }).catch(() => {});
const st = await page.evaluate(() => {
  const g = window.__aegisWeb || {};
  const tabs = [...document.querySelectorAll('#msg-inner table')];
  return {
    conectado: document.querySelector('#conn-text')?.textContent,
    msgsPintados: document.querySelectorAll('.msg-a,.msg-user,.tool').length,
    nodos: document.querySelectorAll('#msg-inner *').length,
    tablasEnHistorial: tabs.length,
    superficie: ['softResync', 'sweepTools', 'metrics', 'watchDbg', 'md', 'probeRun'].filter((k) => typeof g[k] !== 'undefined'),
    busy: g.state?.busy, adopted: g.state?.adopted,
  };
});
console.log(JSON.stringify({ ...st, sesion: big, replayMs: Date.now() - t0, errores: errs }, null, 1));
await br.close();
process.exit(0);
