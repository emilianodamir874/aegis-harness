import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 430, height: 900 } });
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.click('#btn-menu').catch(() => {});
await p.waitForTimeout(600);
const f = await p.$('[data-id]');
if (f) await f.click({ timeout: 8000 }).catch(() => {});
await p.waitForTimeout(3500);
const r = await p.evaluate(() => {
  const m = (sel) => { const n = document.querySelector(sel); if (!n) return null; const b2 = n.getBoundingClientRect(); return Math.round(b2.width) + 'x' + Math.round(b2.height); };
  const sb = document.querySelector('.sb-search');
  return {
    anchoLectura: getComputedStyle(document.querySelector('.msg-inner')).maxWidth,
    composer: getComputedStyle(document.querySelector('.composer')).maxWidth,
    search: m('#search'), buscadorCaja: sb ? Math.round(sb.getBoundingClientRect().height) + 'px' : null,
    iconBtn: m('.icon-btn'), chip: m('.chip'), detener: m('#runbar-stop'), menu: m('#btn-menu'),
    filaBotones: m('.sb-rename'), cargarMas: m('.sb-more-btn'),
    textosChicos: [...document.querySelectorAll('span.kbd-hint, .brand-chip, .sb-group')].map((n) => getComputedStyle(n).fontSize),
    scroll: document.documentElement.scrollWidth + ' vs ' + document.documentElement.clientWidth,
  };
});
console.log(JSON.stringify(r, null, 1));
await b.close();
