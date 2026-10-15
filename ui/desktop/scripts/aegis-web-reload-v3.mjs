import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const url = 'http://' + cfg.publicHost + ':' + cfg.webPort + '/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.addInitScript(() => {
  const O = window.WebSocket;
  function W(u, p) { return new O(String(u).replace(':3284', ':3391'), p); }
  W.prototype = O.prototype; Object.assign(W, O);
  window.WebSocket = W;
});
await page.goto(url);
await page.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc && window.__aegisWeb.rpc.ready, null, { timeout: 30000 });
await page.waitForTimeout(2000);
await page.evaluate(() => document.querySelector('#btn-new').click());
await page.waitForTimeout(2500);
await page.fill('#input', 'Usa execute_typescript con: await new Promise(r => setTimeout(r, 15000)); despues responde exactamente LISTO');
await page.keyboard.press('Enter');
const sid = await page.evaluate(() => (window.__aegisWeb.state.current || {}).id);
console.log('SID=' + sid);
await page.waitForTimeout(6000);
await page.reload();
console.log('RELOADED');
await page.waitForTimeout(50000);
const d = await page.evaluate(() => ({
  adopted: window.__aegisWeb.state.adopted, busy: window.__aegisWeb.state.busy,
  a: [...document.querySelectorAll('#msg-inner .msg-a')].map((m) => m.textContent.trim().slice(0, 60)).slice(-2),
  listaEnDOM: document.querySelector('#msg-inner').textContent.includes('LISTO'),
}));
console.log('POST ' + JSON.stringify(d));
await browser.close();