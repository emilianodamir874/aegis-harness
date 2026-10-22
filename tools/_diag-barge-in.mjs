// Verifica: (a) un parrafo largo se sintetiza en UN pedido (menos pausas);
// (b) con manos libres, mientras suena la voz el microfono queda escuchando (barge-in).
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788';
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

const PARRAFO = 'Primera oracion del parrafo para medir el troceo con un texto largo de verdad. '
  + 'Segunda oracion, tambien corta pero con algunas palabras mas para sumar caracteres al total. '
  + 'Tercera oracion con mas palabras para llegar al limite sin cortar el parrafo al medio. '
  + 'Cuarta oracion que sigue y agrega contexto suficiente para pasar los cuatrocientos. '
  + 'Quinta oracion para completar el parrafo entero de prueba con un cierre bien marcado. '
  + 'Sexta oracion final del parrafo, que ya deberia superar los setecientos caracteres del texto.';

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav],
});
let sid = '';
let fallo = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const tts = [];
  page.on('request', (r) => { if (r.url().includes('/tts?')) tts.push(r.url()); });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[consola] ' + m.text().slice(0, 160)); });
  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3500);
  for (let i = 0; i < 3 && !sid; i++) {
    await page.click('#btn-new');
    const t = Date.now();
    while (Date.now() - t < 6000) {
      await page.waitForTimeout(500);
      sid = await page.evaluate(() => (window.__aegisWeb.state.current && window.__aegisWeb.state.current.id) || '');
      if (sid) break;
    }
  }
  if (!sid) throw new Error('sin sesion de prueba');

  await page.click('#btn-read');
  await page.waitForTimeout(400);

  // (a) parrafo largo -> un solo pedido
  const antes = tts.length;
  await page.evaluate((txt) => window.__aegisWeb.read.pump('p-1', txt), '## Para escuchar\n\n' + PARRAFO + '\n\n');
  await page.waitForTimeout(3000);
  const pedidos = tts.length - antes;
  console.log('pedidos para un parrafo de ' + PARRAFO.length + ' chars: ' + pedidos);
  if (pedidos > 1) throw new Error('el parrafo se partio en ' + pedidos + ' pedidos');

  // (b) barge: con SOLO lectura encendida (sin manos libres), el micro escucha mientras suena
  await page.evaluate(() => window.__aegisWeb.micOff());
  await page.waitForTimeout(600);
  tts.length = 0;
  await page.evaluate((txt) => window.__aegisWeb.read.pump('p-2', txt), '## Para escuchar\n\nOtra frase para probar la interrupcion.\n\n');
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => window.__aegisWeb.bargeNow());
  const con = await page.evaluate(() => (window.__aegisWeb.state && window.__aegisWeb.state.busy) || false);
  console.log('busy=' + con);
  console.log('bargeNow: ' + JSON.stringify(st));
  if (!st.playing) throw new Error('el audio no esta sonando');
  if (!st.rec) throw new Error('el microfono no quedo escuchando durante la voz');
  if (!st.barge) throw new Error('el microfono no se abrio en modo barge-in');

  console.log('PASS barge-in escuchando durante la voz');

  if (errs.length) throw new Error('errores de pagina: ' + errs.join(' | '));
} catch (e) {
  fallo = true;
  console.error('FALLA ' + e.message);
} finally {
  if (sid) { try { await req('_aegis/unstable/session/archive', { sessionId: sid }); console.log('sesion archivada'); } catch (e) {} }
  await browser.close();
  ws.close();
}
process.exit(fallo ? 1 : 0);
