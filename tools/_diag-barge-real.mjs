// Barge-in end-to-end: el micro falso reproduce una voz humana (WAV) mientras suena el TTS.
// Debe dispararse la interrupcion: playing=false y hits>=3.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788';
const voz = 'C:/Aegis-Proyects/web/tools/_voz-humana-4s.wav';

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
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'barge-real', version: '1' } });

const TEXTO = 'Esta es una lectura larga para dar tiempo a interrumpir. '.repeat(6);

const browser = await chromium.launch({
  headless: true,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=' + voz,
  ],
});
let sid = '';
let fallo = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
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

  await page.click('#btn-read');   // pide el micro en el mismo gesto
  await page.waitForTimeout(1500);
  console.log('tras encender lectura: ' + JSON.stringify(await page.evaluate(() => window.__aegisWeb.bargeLog())));

  await page.evaluate((txt) => window.__aegisWeb.read.pump('b-1', '## Para escuchar\n\n' + txt), TEXTO + '\n\n');
  await page.waitForTimeout(1500);
  const enCurso = await page.evaluate(() => window.__aegisWeb.bargeLog());
  console.log('sonando: ' + JSON.stringify(enCurso));

  // La voz humana entra por el micro falso; esperar a que el VAD dispare (3 tramas a 100 ms).
  let st = enCurso;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    await page.waitForTimeout(300);
    st = await page.evaluate(() => window.__aegisWeb.bargeLog());
    if (!st.playing) break;
  }
  console.log('final: ' + JSON.stringify(st));
  if (st.playing) throw new Error('la voz no se interrumpio');
  if ((st.hits || 0) < 3) throw new Error('no se acumularon las 3 tramas: ' + st.hits);
  if (errs.length) throw new Error('errores de pagina: ' + errs.join(' | '));
  console.log('PASS interrupcion por voz real');
} catch (e) {
  fallo = true;
  console.error('FALLA ' + e.message);
} finally {
  if (sid) { try { await req('_aegis/unstable/session/archive', { sessionId: sid }); console.log('sesion archivada'); } catch (e) {} }
  await browser.close();
  ws.close();
}
process.exit(fallo ? 1 : 0);
