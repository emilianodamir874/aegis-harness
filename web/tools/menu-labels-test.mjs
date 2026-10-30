import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(2000);
await p.click('#btn-menu').catch(() => {});
await p.waitForTimeout(900);
await p.click('[data-id]').catch(() => {});
await p.waitForTimeout(5000);
const info = await p.evaluate(() => {
  const out = [];
  for (const w of document.querySelectorAll('#chips .chip-wrap')) {
    w.querySelector('button.chip').click();
    const menu = [...document.querySelectorAll('.menu')].find((m) => !m.hidden);
    if (!menu) { out.push({ chip: w.querySelector('button.chip').textContent, error: 'no abrio' }); continue; }
    const r = menu.getBoundingClientRect();
    out.push({ chip: w.querySelector('button.chip').textContent, x: Math.round(r.x), ancho: Math.round(r.width), desborde: r.left < 0 || r.right > document.documentElement.clientWidth ? 'MAL' : 'ok', filas: [...menu.children].map((f) => f.textContent.trim()) });
    [...document.querySelectorAll('.menu')].forEach((m) => (m.hidden = true));
  }
  return out;
});
await p.screenshot({ path: 'C:/Users/Emiliano/tmp/inv/cel-labels.png' });
console.log(JSON.stringify(info, null, 1));
await b.close();
