// Diagnostico end-to-end del modo debate:
//   1. imprime los configOptions de la sesion (para ver si existe thinking_effort);
//   2. prende debate y verifica que el esfuerzo quede en 'off' (si el proveedor lo expone);
//   3. manda un turno corto y espera a que termine (busy true -> false);
//   4. deja el sessionId en tmp/debate-sid.txt para revisar agentVisible en la DB;
//   5. apaga debate y archiva la sesion.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

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
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'debate-e2e', version: '1' } });

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

  await page.click('#btn-new');
  await page.waitForTimeout(2500);
  sid = await page.evaluate(() => (window.__aegisWeb && window.__aegisWeb.state.current && window.__aegisWeb.state.current.id) || '');
  if (!sid) throw new Error('no se creo el chat de prueba');
  console.log('chat de prueba: ' + sid);

  const opts = await page.evaluate(() => ((window.__aegisWeb.state.current.configOptions) || []).map((o) => o.id + '=' + o.currentValue));
  console.log('configOptions: ' + JSON.stringify(opts));

  await page.click('#btn-debate');
  await page.waitForTimeout(2000);

  const after = await page.evaluate(() => {
    const o = ((window.__aegisWeb.state.current.configOptions) || []).find((x) => x.id === 'thinking_effort');
    return o ? o.currentValue : null;
  });
  console.log('thinking_effort con debate ON: ' + JSON.stringify(after));

  await page.fill('#input', 'Contestá solo con la palabra ok.');
  await page.press('#input', 'Enter');

  const t0 = Date.now();
  let busyVisto = false;
  while (Date.now() - t0 < 60000) {
    await page.waitForTimeout(500);
    const busy = await page.evaluate(() => !!(window.__aegisWeb && window.__aegisWeb.state.busy));
    if (busy) busyVisto = true;
    if (busyVisto && !busy) break;
  }
  if (!busyVisto) throw new Error('el turno nunca arranco');
  console.log('turno terminado');

  await page.waitForTimeout(2500);   // deja correr el rewind automatico

  // "dale": el debate se cierra y ESE turno tiene que quedar visible para el agente.
  await page.fill('#input', 'dale');
  await page.press('#input', 'Enter');
  const t1 = Date.now();
  let arranco = false;
  while (Date.now() - t1 < 60000) {
    await page.waitForTimeout(500);
    const busy = await page.evaluate(() => !!(window.__aegisWeb && window.__aegisWeb.state.busy));
    if (busy) arranco = true;
    if (arranco && !busy) break;
  }
  if (!arranco) throw new Error('el turno de dale nunca arranco');
  console.log('turno de dale terminado');
  await page.waitForTimeout(1500);
  await page.click('#btn-debate');   // por si quedo encendido: apagarlo
  await page.waitForTimeout(800);
  const off = await page.evaluate(() => {
    const o = ((window.__aegisWeb.state.current.configOptions) || []).find((x) => x.id === 'thinking_effort');
    return o ? o.currentValue : null;
  });
  console.log('thinking_effort con debate OFF: ' + JSON.stringify(off));

  if (errs.length) throw new Error('errores de pagina: ' + errs.join(' | '));
} catch (e) {
  fallo = true;
  console.error('FALLA ' + e.message);
} finally {
  if (sid) {
    await writeFile('C:/Aegis-Proyects/tmp/debate-sid.txt', sid, 'utf8');
    try { await req('_aegis/unstable/session/archive', { sessionId: sid }); console.log('ok: sesion archivada'); }
    catch (e) { console.error('aviso: no pude archivar ' + sid + ': ' + e.message); }
  }
  await browser.close();
  ws.close();
}
process.exit(fallo ? 1 : 0);
