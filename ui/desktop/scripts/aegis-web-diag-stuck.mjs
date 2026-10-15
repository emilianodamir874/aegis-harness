// DIAGNÓSTICO (read-only): abrir el chat "Session stalled after stream" en la web y
// capturar el estado interno del cliente (window.__aegisWeb), la barra de run, el
// tráfico WS y los reportes de consola. NO envía nada.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const TITLE = process.env.DIAG_TITLE || 'Session stalled after stream';
const OUT = process.env.DIAG_OUT || 'C:/goose-web/tools/diag-stuck.json';
const WAIT_MS = Number(process.env.DIAG_WAIT_MS || 12000);

const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
const p = await ctx.newPage();
const wsFrames = [];
const consoleMsgs = [];
p.on('websocket', (ws) => {
  wsFrames.push('WS OPEN ' + ws.url().replace(/token=[^&]+/, 'token=***'));
  ws.on('framesent', (f) => wsFrames.push('>> ' + String(f.payload).slice(0, 260)));
  ws.on('framereceived', (f) => wsFrames.push('<< ' + String(f.payload).slice(0, 260)));
  ws.on('close', () => wsFrames.push('WS CLOSE'));
});
p.on('console', (m) => consoleMsgs.push(m.type() + ': ' + m.text().slice(0, 220)));
p.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + String(e).slice(0, 400)));
p.on('requestfailed', (r) => consoleMsgs.push('REQFAIL: ' + r.url().slice(0, 120) + ' ' + (r.failure() || {}).errorText));

const snap = async (label) => {
  const s = await p.evaluate(() => {
    const G = window.__aegisWeb || {};
    const st = G.state || {};
    const rb = document.querySelector('#runbar');
    return {
      label: null,
      busy: !!st.busy,
      adopted: !!st.adopted,
      runId: st.runId,
      current: st.current && st.current.id,
      queue: (st.queue || []).length,
      steers: st.steers ? [...st.steers.keys()] : null,
      hold: st.hold || null,
      runbarHidden: rb ? rb.hidden : null,
      runbarText: (document.querySelector('#runbar-text') || {}).textContent,
      sendHidden: (document.querySelector('#btn-send') || {}).hidden,
      stopHidden: (document.querySelector('#btn-stop') || {}).hidden,
      connText: (document.querySelector('#conn-text') || {}).textContent,
      title: (document.querySelector('#chat-title') || {}).textContent,
      msgsCount: document.querySelectorAll('#messages > *').length,
      msgsTail: [...document.querySelectorAll('#messages > *')].slice(-8).map((e) => ((e.className || '') + ' | ' + String(e.innerText || '').replace(/\s+/g, ' ').slice(0, 160))),
      sysnotes: [...document.querySelectorAll('.sysnote')].map((e) => e.innerText.replace(/\s+/g, ' ')).slice(-8),
      last: localStorage.getItem('gweb.last'),
      pending: localStorage.getItem('gweb.pendingSteers'),
    };
  });
  s.label = label;
  return s;
};

await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2500);
const before = await snap('boot');

const clicked = await p.evaluate((title) => {
  const rows = [...document.querySelectorAll('#session-list .sb-row')];
  const row = rows.find((el) => new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(el.innerText));
  if (!row) return { ok: false, titles: rows.slice(0, 6).map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 60)) };
  const item = row.querySelector('.sb-item'); (item || row).click();
  return { ok: true, id: row.dataset.id };
}, TITLE);

await p.waitForTimeout(WAIT_MS);
const mid = await snap('opened');
const framesAtOpen = wsFrames.length;

// otro tramo para ver el sondeo periódico
await p.waitForTimeout(WAIT_MS);
const end = await snap('later');

const wsSlice = wsFrames.slice(Math.max(0, framesAtOpen - 30));
const result = { title: TITLE, clicked, before, mid, end, wsFrames: wsSlice, console: consoleMsgs.slice(-40) };
writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log(JSON.stringify({ clicked, before, mid, end }, null, 1));
console.log('=== WS frames (from open onward, up to 120) ===');
console.log(wsSlice.slice(0, 120).join('\n'));
console.log('=== console (last 25) ===');
console.log(consoleMsgs.slice(-25).join('\n'));
await b.close();
process.exit(0);
