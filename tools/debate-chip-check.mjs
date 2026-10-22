// Verifica el chip "Debate" en el navegador real contra el serve vivo:
//   1. el chip se renderiza con la etiqueta y el estado iniciales;
//   2. al encenderlo, la sesion de prueba pasa a modo `chat` en el server (sin herramientas);
//   3. al apagarlo, vuelve a `auto`;
//   4. no hubo errores de pagina.
// Crea un chat nuevo para no tocar la sesion en uso y lo archiva al final.
// OJO: este archivo es ASCII a proposito (evita mojibake al editarlo desde PowerShell).
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788';
const cwd = cfg.cwd || 'C:/Aegis-Proyects';

const wsUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
let id = 0;
const pend = new Map();
const ws = new WebSocket(wsUrl);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) => new Promise((res, rej) => {
  const mid = ++id;
  pend.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
});
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'debate-check', version: '1' } });

const chipState = () => {
  const b = document.getElementById('btn-debate');
  return b ? { text: b.textContent, pressed: b.getAttribute('aria-pressed') } : null;
};

const browser = await chromium.launch({ headless: true });
let sid = '';
let fallo = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  const chip = await page.evaluate(chipState);
  if (!chip) throw new Error('no existe #btn-debate (el chip no se renderizo)');
  if (chip.text.trim() !== 'Debate') throw new Error('etiqueta inicial inesperada: ' + JSON.stringify(chip));
  if (chip.pressed !== 'false') throw new Error('aria-pressed inicial inesperado: ' + JSON.stringify(chip));
  console.log('PASS chip Debate renderizado ' + JSON.stringify(chip));

  await page.click('#btn-new');
  await page.waitForTimeout(2500);
  sid = await page.evaluate(() => (window.__aegisWeb && window.__aegisWeb.state.current && window.__aegisWeb.state.current.id) || '');
  if (!sid) throw new Error('no pude crear/identificar el chat de prueba');
  console.log('PASS chat de prueba ' + sid);

  await page.click('#btn-debate');
  await page.waitForTimeout(1500);
  const on = await page.evaluate(chipState);
  if (on.text.indexOf('ON') < 0 || on.pressed !== 'true') throw new Error('no encendio: ' + JSON.stringify(on));
  console.log('PASS debate encendido ' + JSON.stringify(on));

  const load1 = await req('session/load', { sessionId: sid, cwd, mcpServers: [] });
  const modo1 = (load1.modes && load1.modes.currentModeId) || '';
  if (modo1 !== 'chat') throw new Error('el server no quedo en chat: ' + modo1);
  console.log('PASS server en modo chat (sin herramientas) para ' + sid);

  await page.click('#btn-debate');
  await page.waitForTimeout(1500);
  const off = await page.evaluate(chipState);
  if (off.text.trim() !== 'Debate' || off.pressed !== 'false') throw new Error('no apago: ' + JSON.stringify(off));
  const load2 = await req('session/load', { sessionId: sid, cwd, mcpServers: [] });
  const modo2 = (load2.modes && load2.modes.currentModeId) || '';
  if (modo2 !== 'auto') throw new Error('el server no volvio a auto: ' + modo2);
  console.log('PASS debate apagado y server en auto');

  if (errs.length) throw new Error('errores de pagina: ' + errs.join(' | '));
  console.log('PASS sin errores de pagina');
} catch (e) {
  fallo = true;
  console.error('FALLA ' + e.message);
} finally {
  if (sid) {
    try { await req('_aegis/unstable/session/archive', { sessionId: sid }); console.log('ok: sesion de prueba archivada'); }
    catch (e) { console.error('aviso: no pude archivar ' + sid + ': ' + e.message); }
  }
  await browser.close();
  ws.close();
}
process.exit(fallo ? 1 : 0);
