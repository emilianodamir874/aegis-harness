// Verifica: (1) en streaming REAL (el cliente manda el prompt) el cursor SÍ aparece;
// (2) al terminar, desaparece. Limpia la sesión al final.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));

const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2000);
await p.click('#btn-new'); await p.waitForTimeout(1500);
const sid = await p.evaluate(() => localStorage.getItem('gweb.last'));
await p.fill('#input', 'Escribí un párrafo de 200 palabras sobre el río Paraná, en un solo bloque de texto. Nada más.');
await p.click('#btn-send');
const samples = []; let maxCur = 0, sawBar = false;
for (let i = 0; i < 110; i++) {
  await p.waitForTimeout(400);
  const s = await p.evaluate(() => ({
    c: document.querySelectorAll('.streaming').length,
    bar: !!(document.querySelector('#runbar') && !document.querySelector('#runbar').hidden),
    t: (document.querySelector('#runbar-text') || {}).textContent,
  }));
  samples.push(`${s.c}${s.bar ? '/bar:' + (s.t || '').slice(0, 22) : ''}`);
  maxCur = Math.max(maxCur, s.c);
  if (s.bar) sawBar = true;
  if (i > 8 && !s.bar && s.c === 0) break;
}
await p.waitForTimeout(1500);
const fin = await p.evaluate(() => ({ c: document.querySelectorAll('.streaming').length, bar: !!(document.querySelector('#runbar') && !document.querySelector('#runbar').hidden) }));
console.log(JSON.stringify({ sid, sawBar, maxCur, fin, muestras: samples.join(' | ') }, null, 1));
try {
  const ws = new WebSocket(`ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`);
  await new Promise((r) => ws.addEventListener('open', r)); let id = 0; const pend = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
  await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cleanup', version: '1' } });
  await req('session/delete', { sessionId: sid });
  console.log('sesion borrada:', sid); ws.close();
} catch (e) { console.log('no se pudo borrar:', String(e).slice(0, 120)); }
await b.close();
process.exit(0);
