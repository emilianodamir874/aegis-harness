import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const sid = process.argv[2];
const url = 'http://' + cfg.publicHost + ':' + cfg.webPort + '/';
const browser = await chromium.launch();
const page = await browser.newPage();
// Fijar la sesion a abrir ANTES de que arranque la app.
await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, ['gweb.last', sid]);
await page.goto(url);
await page.waitForFunction(() => document.querySelectorAll('#msg-inner .tool').length > 0, null, { timeout: 60000 });
await page.waitForTimeout(6000); // dejar terminar replay + probe de checkAdoptedRun
const r = await page.evaluate(() => {
  const tools = [...document.querySelectorAll('#msg-inner .tool')];
  const marked = tools.filter((t) => t.querySelector('.tool-title .tint'));
  const spinning = tools.filter((t) => t.querySelector('.spin'));
  const runbar = document.querySelector('#runbar');
  return {
    tools: tools.length,
    marcadas: marked.length,
    girando: spinning.length,
    runbarVisible: !!(runbar && !runbar.hidden),
    runbarText: runbar ? document.querySelector('#runbar-text').textContent : null,
    ejemplo: marked.length ? marked[0].querySelector('.tool-title').textContent.trim() : null,
  };
});
console.log('RESULT ' + sid + ' ' + JSON.stringify(r));
await browser.close();
process.exit(0);
