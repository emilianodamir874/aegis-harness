import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = 'http://' + cfg.publicHost + ':' + cfg.webPort + '/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const out = {};
for (const sid of ['20261012_25', '20261012_41']) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
  await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, ['gweb.last', sid]);
  await page.goto(url);
  await page.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc && window.__aegisWeb.rpc.ready, null, { timeout: 30000 });
  await page.waitForTimeout(11000);
  out[sid] = await page.evaluate(() => {
    const titulos = [...document.querySelectorAll('.tool .tool-title')].map((t) => t.textContent.trim());
    const reales = titulos.filter((t) => t && t !== 'Herramienta');
    const tipos = {};
    for (const s of document.querySelectorAll('.tool .tico')) tipos[s.innerHTML.slice(24, 44)] = (tipos[s.innerHTML.slice(24, 44)] || 0) + 1;
    return { total: titulos.length, reales: reales.length, ejemplos: reales.slice(0, 6), iconosDistintos: Object.keys(tipos).length };
  });
  await page.close();
}
console.log('TITULOS ' + JSON.stringify(out, null, 1));
await browser.close();
process.exit(0);
