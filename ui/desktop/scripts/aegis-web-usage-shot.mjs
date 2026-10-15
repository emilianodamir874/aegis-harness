import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = 'http://' + cfg.publicHost + ':' + cfg.webPort + '/';
const sid = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 980, height: 620 }, deviceScaleFactor: 2 });
await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, ['gweb.last', sid]);
await page.goto(url);
await page.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc && window.__aegisWeb.rpc.ready, null, { timeout: 30000 });
await page.waitForTimeout(9000);
await page.click('#meta-right');
await page.waitForTimeout(1200);
const geo = await page.evaluate(() => {
  const p = document.querySelector('#usage-pop'), a = document.querySelector('#meta-right');
  if (!p || !a) return { err: 'falta popover o readout' };
  const pr = p.getBoundingClientRect(), ar = a.getBoundingClientRect();
  return {
    visible: !p.hidden, arriba: p.dataset.above,
    pop: { w: Math.round(pr.width), h: Math.round(pr.height), top: Math.round(pr.top), left: Math.round(pr.left) },
    anchor: { top: Math.round(ar.top), left: Math.round(ar.left), right: Math.round(ar.right) },
    readout: a.textContent,
  };
});
await page.screenshot({ path: 'C:/Aegis-Proyects/web/tools/shot-pop.png' });
console.log('GEO ' + JSON.stringify(geo));
await browser.close();
process.exit(0);
