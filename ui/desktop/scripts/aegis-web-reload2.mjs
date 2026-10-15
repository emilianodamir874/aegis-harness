import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const url = 'http://' + cfg.publicHost + ':' + cfg.webPort + '/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.goto(url);
await page.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc && window.__aegisWeb.rpc.ready, null, { timeout: 30000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.querySelector('#btn-new').click());
await page.waitForTimeout(2500);
const sid = await page.evaluate(() => (window.__aegisWeb.state.current || {}).id);
await page.fill('#input', 'Usá execute_typescript con: await new Promise(r => setTimeout(r, 12000)); y respondé exactamente OK.');
await page.click('#btn-send');
await page.waitForTimeout(5000);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(6000);
const a = await page.evaluate(() => ({ bar: !!document.querySelector('.runbar'), txt: [...document.querySelectorAll('#msg-inner .msg-a')].map((m) => m.textContent.slice(0, 40)) }));
await page.waitForTimeout(45000);
const b = await page.evaluate(() => ({
  bar: !!document.querySelector('.runbar'),
  auth: window.__aegisWeb.state.authStreamIds ? Object.keys(window.__aegisWeb.state.authStreamIds).length : null,
  txt: [...document.querySelectorAll('#msg-inner .msg-a')].map((m) => m.textContent.trim().slice(0, 60)),
}));
console.log('SID ' + sid + ' A ' + JSON.stringify(a) + ' B ' + JSON.stringify(b));
await browser.close();
process.exit(0);
