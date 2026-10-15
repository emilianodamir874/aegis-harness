// Micro-repro: estado del cliente al arrancar en una sesion nueva vacia.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));

const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => localStorage.setItem('gweb.last', '20261012_38'));
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
const muestras = [];
for (let i = 0; i < 12; i++) {
  await p.waitForTimeout(1000);
  muestras.push(await p.evaluate(() => {
    const G = window.__aegisWeb || {}; const s = G.state || {};
    const send = document.querySelector('#btn-send');
    const stop = document.querySelector('#btn-stop');
    return {
      busy: !!s.busy, adopted: !!s.adopted, cur: s.current && s.current.id, ready: !!(G.rpc && G.rpc.ready),
      sendHidden: send ? send.hidden : 'n/a', stopHidden: stop ? stop.hidden : 'n/a',
      inputVal: (document.querySelector('#input') || {}).value,
      footer: (document.querySelector('#composer-hint') || document.querySelector('.composer-hint') || {}).textContent || null,
      runbar: (() => { const r = document.querySelector('#runbar'); return r ? !r.hidden : 'n/a'; })(),
    };
  }));
}
console.log(JSON.stringify({ muestras, sess: await p.evaluate(() => localStorage.getItem('gweb.last')) }, null, 1));
await b.close();
process.exit(0);
