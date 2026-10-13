// Humo v6.2: la app publicada arranca, expone la superficie nueva y no hay errores de JS.
import { chromium } from '@playwright/test';
const br = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);
const st = await page.evaluate(() => {
  const g = window.__gooseWeb || {};
  return {
    conectado: document.querySelector('#conn-text')?.textContent,
    sesiones: (g.state && g.state.sessions || []).length,
    superficie: ['softResync', 'sweepTools', 'metrics', 'watchDbg', 'stopWatch', 'probeRun'].filter((k) => typeof g[k] !== 'undefined'),
    version: (document.querySelector('#conn-host')?.textContent || '') + '',
    composer: !!document.querySelector('#input'),
  };
});
console.log(JSON.stringify({ ...st, errores: errs }, null, 1));
await br.close();
process.exit(0);
