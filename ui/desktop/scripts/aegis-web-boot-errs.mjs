// Diagnostico: errores de consola/pageerror al abrir una sesion + estado.
import { chromium } from '@playwright/test';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
const errores = [];
const consola = [];
p.on('pageerror', (e) => errores.push(String(e).slice(0, 300)));
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consola.push(m.type() + ': ' + m.text().slice(0, 200)); });
await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => localStorage.setItem('gweb.last', '20261012_38'));
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(6000);
const st = await p.evaluate(() => {
  const G = window.__aegisWeb || {}; const s = G.state || {};
  return {
    busy: !!s.busy, cur: s.current && s.current.id,
    sendHidden: document.querySelector('#btn-send')?.hidden,
    itemsSidebar: [...document.querySelectorAll('.sb-item')].slice(0, 6).map((e) => e.innerText.slice(0, 40)),
    tiene38: [...document.querySelectorAll('.sb-item')].some((e) => /swallow/.test(e.innerText)),
    msgs: (document.querySelector('#messages') || {}).innerText?.slice(0, 120),
  };
});
console.log(JSON.stringify({ errores, consola: consola.slice(0, 15), st }, null, 1));
await b.close();
process.exit(0);
