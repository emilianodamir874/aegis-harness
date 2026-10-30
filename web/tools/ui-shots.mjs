// Captura el estado real de la UI (antes/despues de un cambio) y vuelca metricas del DOM.
// Uso: node tools/ui-shots.mjs <carpeta-salida>
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:3788';
const out = process.argv[2] || 'tools/shots/ui';
await mkdir(out, { recursive: true });

const browser = await chromium.launch();

async function shot(page, name, full = false) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(out, name + '.png'), fullPage: full });
}

const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 200)));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#session-list .sb-row', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
await shot(page, '01-desktop-empty');

// metricas de layout del shell
const metrics = await page.evaluate(() => {
  const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const cs = getComputedStyle(document.body);
  return {
    sidebar: r('#sidebar'), topbar: r('.topbar'), messages: r('#messages'), composer: r('.composer'),
    firstRow: r('#session-list .sb-row'), chip: r('#chips .chip'),
    bodyFont: cs.fontFamily, bodySize: cs.fontSize,
    rows: document.querySelectorAll('#session-list .sb-row').length,
    hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    docW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
  };
});
console.log('METRICS ' + JSON.stringify(metrics, null, 1));

// abrir una sesion con contenido
const picked = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#session-list .sb-row')];
  const withCount = rows.map((r) => ({ id: r.getAttribute('data-id'), sub: r.querySelector('.sb-sub')?.textContent || '' }))
    .filter((x) => /(\d{2,})/.test(x.sub));
  return withCount.slice(0, 6);
});
console.log('CANDIDATAS ' + JSON.stringify(picked));
if (picked.length) {
  await page.click(`#session-list .sb-row[data-id="${picked[0].id}"] .sb-item`);
  await page.waitForTimeout(2500);
  await shot(page, '02-desktop-session');
  await shot(page, '03-desktop-session-full', true);
}

// popover de objetivos + menu de modelo + tamano de letra
for (const [sel, name] of [['#btn-goals', '04-goals'], ['#btn-chat-font', '05-font']]) {
  const el = await page.$(sel);
  if (!el) continue;
  await el.click();
  await page.waitForTimeout(500);
  await shot(page, name);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

// menu de chips (proveedor/modelo)
const chip = await page.$('#chips .chip');
if (chip) {
  await chip.click();
  await page.waitForTimeout(500);
  await shot(page, '06-chip-menu');
  await page.keyboard.press('Escape');
}

// slash menu
await page.click('#input');
await page.keyboard.type('/');
await page.waitForTimeout(600);
await shot(page, '07-slash');
await page.evaluate(() => { const i = document.querySelector('#input'); i.value = ''; });

// mobile
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mp = await mctx.newPage();
await mp.goto(BASE, { waitUntil: 'domcontentloaded' });
await mp.waitForSelection?.();
await mp.waitForTimeout(2500);
await shot(mp, '10-mobile-empty');
if (picked.length) {
  await mp.click('#btn-menu').catch(() => {});
  await mp.waitForTimeout(600);
  await shot(mp, '11-mobile-drawer');
  await mp.click(`#session-list .sb-row[data-id="${picked[0].id}"] .sb-item`).catch(() => {});
  await mp.waitForTimeout(2500);
  await shot(mp, '12-mobile-session');
}
const mmetrics = await mp.evaluate(() => ({
  hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  docW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
  composer: (() => { const b = document.querySelector('.composer').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })(),
  send: (() => { const b = document.querySelector('#btn-send').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })(),
}));
console.log('MOBILE ' + JSON.stringify(mmetrics));
console.log('ERRORS ' + JSON.stringify(errors.slice(0, 20), null, 1));
await browser.close();
