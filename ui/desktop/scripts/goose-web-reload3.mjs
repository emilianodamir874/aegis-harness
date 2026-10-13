import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = 'http://' + cfg.publicHost + ':' + cfg.webPort + '/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const snap = async (tag) => {
  const d = await page.evaluate(() => ({
    busy: window.__gooseWeb.state.busy, adopted: window.__gooseWeb.state.adopted,
    wd: JSON.parse(JSON.stringify(window.__gooseWeb.watchDbg)),
    msgs: [...document.querySelectorAll('#msg-inner .msg-a, #msg-inner .msg-user')].map((m) => m.className.split(' ')[0] + ':' + m.textContent.trim().slice(0, 28)),
  }));
  console.log(tag + ' ' + JSON.stringify(d));
};
await page.goto(url);
await page.waitForFunction(() => window.__gooseWeb && window.__gooseWeb.rpc && window.__gooseWeb.rpc.ready, null, { timeout: 30000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.querySelector('#btn-new').click());
await page.waitForTimeout(2500);
await page.fill('#input', 'Usá execute_typescript con: await new Promise(r => setTimeout(r, 25000)); y respondé exactamente LISTO.');
await page.click('#btn-send');
await page.waitForTimeout(6000);
await snap('PRE ');
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(14000);
await snap('POST14 ');
await page.waitForTimeout(70000);
await snap('POST84 ');
await browser.close();
process.exit(0);
