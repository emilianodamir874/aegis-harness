import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = 'http://' + cfg.publicHost + ':' + cfg.webPort + '/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, ['gweb.last', '20261012_25']);
await page.goto(url);
await page.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc && window.__aegisWeb.rpc.ready, null, { timeout: 30000 });
await page.waitForTimeout(9000);
// 1) bienvenida: chat nuevo
await page.click('#btn-new');
await page.waitForTimeout(1500);
await page.screenshot({ path: 'C:/goose-web/tools/shot-welcome.png' });
// 2) zona media de la sesion grande: asistente + tool cards
await page.evaluate(() => {
  const a = [...document.querySelectorAll('.sb-item')].find((x) => (x.querySelector('.sb-title') || {}).textContent === 'Aegis session 20261011_5');
  if (a) a.click();
});
await page.waitForTimeout(9000);
const info = await page.evaluate(() => {
  const m = document.querySelector('.messages');
  m.scrollTop = Math.round(m.scrollHeight * 0.42);
  return { assistants: document.querySelectorAll('.msg-a').length, tools: document.querySelectorAll('.tool').length, pres: document.querySelectorAll('.msg-a pre').length };
});
await page.waitForTimeout(800);
await page.screenshot({ path: 'C:/goose-web/tools/shot-mid.png' });
console.log('MID ' + JSON.stringify(info));
await browser.close();
process.exit(0);
