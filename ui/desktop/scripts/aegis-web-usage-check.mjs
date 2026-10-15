import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const url = 'http://' + cfg.publicHost + ':' + cfg.webPort + '/';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url);
await page.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc && window.__aegisWeb.rpc.ready, null, { timeout: 30000 });
await page.click('#btn-new');
await page.waitForTimeout(1200);
await page.fill('#input', 'Respondé exactamente: ok');
await page.press('#input', 'Enter');
await page.waitForFunction(() => { const s = window.__aegisWeb.state; return !s.busy && !s.runId; }, null, { timeout: 180000 });
await page.waitForTimeout(4000);
const r = await page.evaluate(() => {
  const g = window.__aegisWeb;
  const el0 = g.metaRight();
  const antes = { texto: el0.textContent, titulo: el0.title, nivel: el0.dataset.level };
  g.renderUsagePublic(); // forzar un render con el estado actual
  const el1 = g.metaRight();
  return {
    antes,
    despues: { texto: el1.textContent, titulo: el1.title.slice(0, 200), nivel: el1.dataset.level },
    mismoNodo: el0 === el1,
    usage: g.usageState(),
    dbg: g.usageDbg(),
    sid: g.state.current && g.state.current.id,
    bus: !!(g.state.busy),
  };
});
console.log('DBG ' + JSON.stringify(r, null, 1));
await browser.close();
process.exit(0);
