// Verifica el modo debate/manos libres en el navegador real contra el serve vivo:
//   1. el chip se renderiza con la etiqueta y el estado iniciales;
//   2. al prenderlo, la sesion de prueba pasa a modo `chat` (sin herramientas), se enciende la
//      lectura y el MICROFONO SE ABRE SOLO (sin tocar el boton del micro);
//   3. al apagarlo, el server vuelve a `auto` y el microfono se cierra;
//   4. no hubo errores de pagina.
// Usa el dispositivo de audio falso de Chromium con un WAV de silencio (2 s): el VAD no detecta
// voz, asi que no se manda ningun turno. Crea un chat nuevo y lo archiva al final.
// OJO: archivo ASCII a proposito (evita mojibake al editarlo desde PowerShell).
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788';
const cwd = cfg.cwd || 'C:/Aegis-Proyects';
const wav = 'C:/Aegis-Proyects/web/tools/_silencio-2s.wav';

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
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'hands-free-check', version: '1' } });

const chipState = () => {
  const b = document.getElementById('btn-debate');
  const mic = document.getElementById('btn-mic');
  const read = document.getElementById('btn-read');
  return {
    text: b ? b.textContent : null,
    pressed: b ? b.getAttribute('aria-pressed') : null,
    micRec: !!(mic && mic.classList.contains('rec')),
    readOn: !!(read && read.classList.contains('on')),
  };
};

async function waitFor(page, fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const st = await page.evaluate(fn);
    if (st) return st;
    if (Date.now() - t0 > ms) return null;
    await page.waitForTimeout(200);
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav],
});
let sid = '';
let fallo = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  const chip = await page.evaluate(chipState);
  if (!chip.text) throw new Error('no existe #btn-debate (el chip no se renderizo)');
  if (chip.text.trim() !== 'Debate') throw new Error('etiqueta inicial inesperada: ' + JSON.stringify(chip));
  if (chip.pressed !== 'false') throw new Error('aria-pressed inicial inesperado: ' + JSON.stringify(chip));
  console.log('PASS chip Debate renderizado ' + JSON.stringify(chip));

  await page.click('#btn-new');
  await page.waitForTimeout(2500);
  sid = await page.evaluate(() => (window.__aegisWeb && window.__aegisWeb.state.current && window.__aegisWeb.state.current.id) || '');
  if (!sid) throw new Error('no pude crear/identificar el chat de prueba');
  console.log('PASS chat de prueba ' + sid);

  await page.click('#btn-debate');
  await page.waitForTimeout(1200);

  const on = await page.evaluate(chipState);
  if (on.text.indexOf('ON') < 0 || on.pressed !== 'true') throw new Error('no encendio: ' + JSON.stringify(on));
  console.log('PASS debate encendido ' + JSON.stringify(on));

  if (!on.readOn) throw new Error('la lectura no se encendio con el debate');
  console.log('PASS lectura encendida junto con el debate');

  const micOn = await waitFor(page, () => {
    const m = document.getElementById('btn-mic');
    return !!(m && m.classList.contains('rec'));
  }, 6000);
  if (!micOn) throw new Error('el microfono NO se abrio solo al prender debate');
  console.log('PASS microfono abierto automaticamente (sin tocar el boton)');

  const load1 = await req('session/load', { sessionId: sid, cwd, mcpServers: [] });
  const modo1 = (load1.modes && load1.modes.currentModeId) || '';
  if (modo1 !== 'chat') throw new Error('el server no quedo en chat: ' + modo1);
  console.log('PASS server en modo chat (sin herramientas) para ' + sid);

  await page.click('#btn-debate');
  await page.waitForTimeout(1200);
  const off = await page.evaluate(chipState);
  if (off.text.trim() !== 'Debate' || off.pressed !== 'false') throw new Error('no apago: ' + JSON.stringify(off));
  console.log('PASS debate apagado ' + JSON.stringify(off));

  const micOff = await waitFor(page, () => {
    const m = document.getElementById('btn-mic');
    return !(m && m.classList.contains('rec'));
  }, 5000);
  if (!micOff) throw new Error('el microfono quedo grabando despues de apagar debate');
  console.log('PASS microfono cerrado al apagar debate');

  const load2 = await req('session/load', { sessionId: sid, cwd, mcpServers: [] });
  const modo2 = (load2.modes && load2.modes.currentModeId) || '';
  if (modo2 !== 'auto') throw new Error('el server no volvio a auto: ' + modo2);
  console.log('PASS server de vuelta en auto');

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
