// Capturas de los cuatro popovers del cromo (letra, uso, objetivos, estado del chat)
// y de la pantalla de inicio, para rediseñarlos sin adivinar como estan hoy.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const ws = new WebSocket(`ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`);
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && !m.method && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: m, params: p || {} })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'pop', version: '1' } });
const sid = (await req('session/new', { cwd: cfg.cwd, mcpServers: [] })).result.sessionId;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__aegisWeb?.chips, null, { timeout: 15000 });

// Pantalla de inicio (sin sesion): la tarjeta de estado del chat.
await page.waitForTimeout(900);
const inicio = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.welcome *, [class*="card"], [class*="panel"]')].filter((e) => /CON QU|Estado|Gasto|Objetivo/i.test(e.textContent || '')).slice(0, 8);
  return cards.map((c) => ({ cls: c.className, txt: (c.textContent || '').trim().slice(0, 120) }));
});
console.log('tarjetas de inicio:', JSON.stringify(inicio, null, 1));
await page.screenshot({ path: 'tools/shots/pop-inicio.png', clip: { x: 260, y: 120, width: 900, height: 700 } });

await page.evaluate((e) => window.__aegisWeb.chips.abrirSesion(e), { sessionId: sid, title: 'pop', cwd: cfg.cwd });
await page.waitForSelector('#chips .chip-model');
await page.waitForTimeout(900);

async function abrir(nombre, fn) {
  try {
    await fn();
    await page.waitForTimeout(450);
    const caja = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el || el.hidden || !el.offsetWidth) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, Math.round(r.x) - 8), y: Math.max(0, Math.round(r.y) - 8), width: Math.round(r.width) + 16, height: Math.round(r.height) + 16 };
    }, nombre.sel);
    if (!caja) { console.log(nombre.id, 'NO VISIBLE'); return; }
    await page.screenshot({ path: `tools/shots/${nombre.id}.png`, clip: caja });
    const m = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const cs = el && getComputedStyle(el);
      return el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), fuente: cs.fontSize, familia: cs.fontFamily.split(',')[0] } : null;
    }, nombre.sel);
    console.log(nombre.id, JSON.stringify(m));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } catch (e) { console.log(nombre.id, 'ERR', String(e).slice(0, 90)); }
}

await abrir({ id: 'pop-letra', sel: '#font-panel .panel' }, async () => { await page.click('#btn-chat-font'); });
await abrir({ id: 'pop-objetivos', sel: '#goals' }, async () => { await page.click('#btn-goals'); });
await abrir({ id: 'pop-uso', sel: '#usage-panel .panel' }, async () => {
  await page.evaluate(() => { const b = document.querySelector('#btn-gasto-top, .usage-mini, #ctx'); if (b) b.click(); });
});
await abrir({ id: 'pop-chatinfo', sel: '#chat-info' }, async () => { await page.click('#btn-chat-info'); });

await browser.close();
await req('session/delete', { sessionId: sid });
ws.close();
process.exit(0);
