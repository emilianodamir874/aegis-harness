// Verifica la regla: con opencode_go (y open_design) el modelo es SIEMPRE deepseek-v4.1-flash.
//  1. al abrir un chat, el modelo es el fijo;
//  2. intentar cambiar de modelo se rechaza (queda el fijo);
//  3. prender Debate NO cambia el modelo.
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

const leer = () => {
  const opts = (window.__aegisWeb.state.current.configOptions) || [];
  const prov = (opts.find((o) => o.id === 'provider') || {}).currentValue;
  const mod = (opts.find((o) => o.id === 'model') || {}).currentValue;
  return { prov, mod };
};

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
  await page.waitForTimeout(4000);
  // El boot puede tardar: se reintenta crear el chat hasta 12 s.
  for (let intento = 0; intento < 3 && !sid; intento++) {
    await page.click('#btn-new');
    const t = Date.now();
    while (Date.now() - t < 6000) {
      await page.waitForTimeout(500);
      sid = await page.evaluate(() => (window.__aegisWeb.state.current && window.__aegisWeb.state.current.id) || '');
      if (sid) break;
    }
  }
  if (!sid) throw new Error('sin sesion de prueba (el boot no creo el chat)');

  const st = await page.evaluate(leer);
  console.log('chat nuevo: provider=' + st.prov + ' model=' + st.mod);

  if (st.prov === 'opencode_go' || st.prov === 'open_design') {
    if (st.mod !== 'deepseek-v4.1-flash') throw new Error('el modelo inicial no es el fijo: ' + st.mod);
    console.log('PASS modelo fijo al abrir el chat');

    await page.evaluate(() => window.__aegisWeb.setConfig('model', 'step-5-preview'));
    await page.waitForTimeout(1500);
    const st2 = await page.evaluate(leer);
    if (st2.mod !== 'deepseek-v4.1-flash') throw new Error('dejo cambiar el modelo a ' + st2.mod);
    console.log('PASS el cambio de modelo se rechaza (sigue ' + st2.mod + ')');

    await page.click('#btn-debate');
    await page.waitForTimeout(2500);
    const st3 = await page.evaluate(leer);
    if (st3.mod !== 'deepseek-v4.1-flash') throw new Error('debate cambio el modelo a ' + st3.mod);
    console.log('PASS debate NO cambia el modelo');
    await page.click('#btn-debate');
    await page.waitForTimeout(1000);
  } else {
    console.log('AVISO: el proveedor activo no es opencode_go/open_design (' + st.prov + '); no aplica');
  }

  if (errs.length) throw new Error('errores de pagina: ' + errs.join(' | '));
} catch (e) {
  fallo = true;
  console.error('FALLA ' + e.message);
} finally {
  if (sid) { try { await req('_aegis/unstable/session/archive', { sessionId: sid }); console.log('sesion de prueba archivada'); } catch (e) {} }
  await browser.close();
  ws.close();
}
process.exit(fallo ? 1 : 0);
