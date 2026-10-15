// Medición de rendimiento del replay de sesiones en aegis-web.
// Abre la sesión más grande del sidebar (o la que coincida con argv[2]) y mide
// cuánto tarda la UI en terminar de pintar el historial.
// Run: cd ui/desktop && node scripts/aegis-web-perf.mjs [url] [titulo]
import { chromium } from '@playwright/test';

const url = process.argv[2] || 'http://192.168.100.34:3788/';
const wanted = process.argv[3] || null;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const out = { url, runs: [] };
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.errors = (out.errors || []).concat('pageerror: ' + String(e.message).slice(0, 200)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 });
  await page.waitForFunction(() => document.querySelectorAll('.sb-item').length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(800);

  // inventario: título + cantidad de mensajes que muestra el sidebar
  out.inventory = await page.evaluate(() =>
    [...document.querySelectorAll('.sb-row')].map((r) => {
      const sub = (r.querySelector('.sb-sub') || {}).textContent || '';
      const m = /^(\d+)/.exec(sub.trim());
      return { title: (r.querySelector('.sb-title') || {}).textContent || '', count: m ? Number(m[1]) : null };
    })
  );

  const targets = wanted ? [wanted] : out.inventory.filter((s) => s.count).sort((a, b) => b.count - a.count).slice(0, 3).map((s) => s.title);
  for (const title of targets) {
    const r = await page.evaluate(async (title) => {
      const row = [...document.querySelectorAll('.sb-row')].find((x) => (x.querySelector('.sb-title') || {}).textContent === title);
      if (!row) return { title, error: 'fila no encontrada' };
      const clickAt = performance.now();
      row.querySelector('.sb-item').click();
      const firstPaint = await new Promise((res) => {
        const iv = setInterval(() => {
          if (document.querySelectorAll('#msg-inner > *').length > 0) { clearInterval(iv); res(performance.now()); }
        }, 20);
        setTimeout(() => { clearInterval(iv); res(null); }, 20000);
      });
      const done = await new Promise((res) => {
        let last = -1, lastChange = performance.now();
        const iv = setInterval(() => {
          const n = document.querySelectorAll('#msg-inner > *').length;
          if (n !== last) { last = n; lastChange = performance.now(); }
          if (performance.now() - lastChange > 700 && performance.now() - clickAt > 900) { clearInterval(iv); res({ n, t: lastChange }); }
          if (performance.now() - clickAt > 120000) { clearInterval(iv); res({ n, t: performance.now(), timeout: true }); }
        }, 60);
      });
      return {
        title,
        domNodes: done.n,
        msFirstPaint: firstPaint ? Math.round(firstPaint - clickAt) : null,
        msTotal: Math.round(done.t - clickAt),
        timeout: !!done.timeout,
        longs: (performance.getEntriesByType('longtask') || []).length || undefined,
      };
    }, title);
    out.runs.push(r);
    await page.waitForTimeout(1200);
  }
  await ctx.close();
} catch (e) {
  out.fatal = String(e && e.stack ? e.stack : e).slice(0, 600);
} finally {
  await browser.close();
}
console.log(JSON.stringify(out, null, 1));
