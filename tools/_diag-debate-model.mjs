// Verifica el cambio de modelo del debate: al prender el chip el modelo pasa a DEBATE_MODEL
// (step-5-preview por defecto), la respuesta no trae "thinking" y al apagarlo vuelve el original.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

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
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'debate-model', version: '1' } });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav],
});
const leerModelo = () => {
  const o = ((window.__aegisWeb.state.current.configOptions) || []).find((x) => x.id === 'model');
  return o ? o.currentValue : null;
};
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
  sid = await page.evaluate(() => (window.__aegisWeb.state.current.id) || '');
  if (!sid) throw new Error('sin sesion de prueba');
  const inicial = await page.evaluate(leerModelo);
  console.log('modelo inicial: ' + inicial);

  await page.click('#btn-debate');
  await page.waitForTimeout(2500);
  const enDebate = await page.evaluate(leerModelo);
  console.log('modelo en debate: ' + enDebate);

  await page.fill('#input', 'Contestá en una frase: ¿de qué hablamos?');
  await page.press('#input', 'Enter');
  const t0 = Date.now();
  let visto = false;
  while (Date.now() - t0 < 60000) {
    await page.waitForTimeout(400);
    const busy = await page.evaluate(() => !!(window.__aegisWeb.state.busy));
    if (busy) visto = true;
    if (visto && !busy) break;
  }
  if (!visto) throw new Error('el turno de debate no arranco');
  await page.waitForTimeout(1200);

  const db = new DatabaseSync('C:/Aegis-Proyects/state/data/sessions/sessions.db', { readOnly: true });
  const row = db.prepare("select content_json from messages where session_id = ? and role = 'assistant' order by rowid desc limit 1").get(sid);
  const kinds = row ? JSON.parse(row.content_json).map((b) => b.type) : [];
  const texto = row ? JSON.parse(row.content_json).filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
  console.log('bloques de la respuesta: ' + JSON.stringify(kinds));
  console.log('respuesta (' + texto.length + ' chars): ' + texto.slice(0, 160).replace(/\n/g, ' '));

  await page.click('#btn-debate');
  await page.waitForTimeout(2500);
  const restaurado = await page.evaluate(leerModelo);
  console.log('modelo tras apagar: ' + restaurado);

  if (enDebate !== 'step-5-preview') throw new Error('no cambio al modelo de debate: ' + enDebate);
  if (kinds.includes('thinking')) throw new Error('la respuesta trajo thinking');
  if (restaurado !== inicial) throw new Error('no restauro el modelo: ' + restaurado);
  if (errs.length) throw new Error('errores de pagina: ' + errs.join(' | '));
  console.log('PASS debate con modelo sin razonamiento y restauracion');
} catch (e) {
  fallo = true;
  console.error('FALLA ' + e.message);
} finally {
  if (sid) {
    await writeFile('C:/Aegis-Proyects/tmp/debate-sid.txt', sid, 'utf8');
    try { await req('_aegis/unstable/session/archive', { sessionId: sid }); console.log('sesion archivada'); } catch (e) {}
  }
  await browser.close();
  ws.close();
}
process.exit(fallo ? 1 : 0);
