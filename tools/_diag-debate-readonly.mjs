// Verifica el perfil de solo lectura del debate: al prenderlo el modo es `auto`, shell/edit/write
// quedan en never_allow (en permission.yaml) y los reads en always_allow; al apagarlo vuelve
// shell=ask_before y el resto a always_allow.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788';
const wav = 'C:/Aegis-Proyects/web/tools/_silencio-2s.wav';
const YAML = 'C:/Aegis-Proyects/state/config/permission.yaml';

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

const nivel = async (tool) => {
  const y = await readFile(YAML, 'utf8');
  const bloque = (nombre) => {
    const m = new RegExp(nombre + ':[^\\n]*\\n((?:\\s+- .*\\n)*)').exec(y);
    return m ? m[1].split('\n').filter(Boolean).map((l) => l.replace(/^\s*-\s*/, '').trim()) : [];
  };
  if (bloque('always_allow').includes(tool)) return 'always_allow';
  if (bloque('ask_before').includes(tool)) return 'ask_before';
  if (bloque('never_allow').includes(tool)) return 'never_allow';
  return 'sin entrada';
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

  console.log('antes: shell=' + (await nivel('shell')) + ' read_file=' + (await nivel('read_file')));

  await page.click('#btn-debate');
  await page.waitForTimeout(3000);
  const modo = await page.evaluate(() => {
    const m = window.__aegisWeb.state.current.modes || {};
    return m.currentModeId || '';
  });
  const shellOn = await nivel('shell');
  const editOn = await nivel('edit');
  const readOn = await nivel('read_file');
  console.log('debate ON: modo=' + modo + ' shell=' + shellOn + ' edit=' + editOn + ' read_file=' + readOn);
  if (modo !== 'auto') throw new Error('el modo no es auto: ' + modo);
  if (shellOn !== 'never_allow') throw new Error('shell no quedo bloqueado: ' + shellOn);
  if (editOn !== 'never_allow') throw new Error('edit no quedo bloqueado: ' + editOn);
  if (readOn !== 'always_allow') throw new Error('read_file no quedo permitido: ' + readOn);
  console.log('PASS debate de solo lectura (sin shell)');

  await page.click('#btn-debate');
  await page.waitForTimeout(2500);
  const shellOff = await nivel('shell');
  const editOff = await nivel('edit');
  console.log('debate OFF: shell=' + shellOff + ' edit=' + editOff);
  if (shellOff !== 'ask_before') throw new Error('shell no volvio a ask_before: ' + shellOff);
  if (editOff !== 'always_allow') throw new Error('edit no volvio a always_allow: ' + editOff);
  console.log('PASS permisos restaurados');

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
