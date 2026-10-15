// Chequeo rápido: carga fresca de una sesión terminada ¿queda cursor pegado?
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));

const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
// abrir la última sesión Feedback _23 (la del debrief v6) — la buscamos por título
await p.waitForFunction(() => document.querySelectorAll('.sb-item').length > 0, null, { timeout: 30000 }).catch(() => {});
const item = p.locator('.sb-item', { hasText: 'Feedback recarga y streaming (2)' }).first();
if (await item.count()) { await item.click(); } else { await p.evaluate(() => localStorage.setItem('gweb.last', '20261012_23')); await p.reload({ waitUntil: 'domcontentloaded' }); }
await p.waitForTimeout(6000);
const snap = await p.evaluate(() => ({
  cursors: document.querySelectorAll('.streaming').length,
  runbar: !!(document.querySelector('#runbar') && !document.querySelector('#runbar').hidden),
  barText: (document.querySelector('#runbar-text') || {}).textContent,
  msgs: document.querySelectorAll('.msg-a').length,
  len: (document.querySelector('#messages') || { innerText: '' }).innerText.length,
  tail: ((document.querySelector('#messages') || { innerText: '' }).innerText || '').slice(-160),
  version: (document.querySelector('#meta-right') || {}).textContent || null,
}));
console.log(JSON.stringify(snap, null, 1));
await b.close();
process.exit(0);
