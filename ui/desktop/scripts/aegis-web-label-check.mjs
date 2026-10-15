import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = 'http://' + cfg.publicHost + ':' + cfg.webPort + '/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.goto(url);
await page.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc && window.__aegisWeb.rpc.ready, null, { timeout: 30000 });
await page.waitForTimeout(3000);
await page.fill('#input', 'Usá execute_typescript para calcular 2+3 y respondé solo el número.');
await page.click('#btn-send');
await page.waitForTimeout(45000);
const info = await page.evaluate(() => {
  const titulos = [...document.querySelectorAll('.tool .tool-title')].map((t) => t.textContent.trim()).filter(Boolean);
  return { sid: (window.__aegisWeb.state.current || {}).id, titulos: titulos.slice(-6), conTitulo: titulos.filter((t) => t !== 'Herramienta').length };
});
console.log('LIVE ' + JSON.stringify(info));
await browser.close();
process.exit(0);
