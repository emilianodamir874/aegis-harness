// A/B del chip sin tocar la app servida: abre la pagina real, recorta el topbar con el CSS
// actual y otra vez con una propuesta inyectada (nunca escribe en app/).
// Uso: node tools/chip-look-ab.mjs [url] [css-opcional]
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://192.168.100.34:3788/';
const CSS = process.argv[3] || 'C:/Aegis-Proyects/web/outbox/chip-propuesta.css';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const propuesta = await readFile(CSS, 'utf8');

const ws = new WebSocket(`ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`);
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && !m.method && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: m, params: p || {} })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'ab', version: '1' } });
const ns = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
const sid = ns.result.sessionId;

const browser = await chromium.launch();

async function foto(nombre, perfil, conPropuesta) {
  const ctx = await browser.newContext({
    viewport: perfil.viewport, deviceScaleFactor: perfil.dpr,
    isMobile: !!perfil.mobile, hasTouch: !!perfil.mobile,
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__aegisWeb?.chips, null, { timeout: 15000 });
  await page.evaluate((e) => window.__aegisWeb.chips.abrirSesion(e), { sessionId: sid, title: 'chip', cwd: cfg.cwd });
  await page.waitForSelector('#chips .chip-model', { timeout: 15000 });
  await page.waitForTimeout(900);
  if (conPropuesta) { await page.addStyleTag({ content: propuesta }); await page.waitForTimeout(250); }
  const caja = await page.evaluate(() => {
    const b = document.querySelector('#chips').getBoundingClientRect();
    return { x: Math.max(0, Math.round(b.x) - 10), y: Math.max(0, Math.round(b.y) - 8), width: Math.min(560, Math.round(b.width) + 20), height: Math.round(b.height) + 16 };
  });
  await page.screenshot({ path: `tools/shots/${nombre}.png`, clip: caja });
  const med = await page.evaluate(() => {
    const c = document.querySelector('#chips .chip-model');
    const r = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    const eff = document.querySelector('#chips .chip-eff');
    return {
      alto: Math.round(r.height), ancho: Math.round(r.width),
      fuente: cs.fontSize, esfuerzo: eff ? getComputedStyle(eff).fontSize + ' ' + getComputedStyle(eff).textTransform : '',
    };
  });
  await ctx.close();
  return { caja, med };
}

const perfilEscritorio = { viewport: { width: 1440, height: 900 }, dpr: 1 };
const perfilA56 = { viewport: { width: 384, height: 832 }, dpr: 2.8125, mobile: true };
const out = {};
out.escritorioAntes = await foto('chip-ab-escritorio-antes', perfilEscritorio, false);
out.escritorioDespues = await foto('chip-ab-escritorio-despues', perfilEscritorio, true);
out.a56Antes = await foto('chip-ab-a56-antes', perfilA56, false);
out.a56Despues = await foto('chip-ab-a56-despues', perfilA56, true);
console.log(JSON.stringify(out, null, 1));

await browser.close();
await req('session/delete', { sessionId: sid });
ws.close();
process.exit(0);
