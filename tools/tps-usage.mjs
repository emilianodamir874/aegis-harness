// Las seis ventanas del runbar suman outputTokens de message_usage recibidos recientemente
// y los dividen por el ancho fijo de cada ventana. El texto visible nunca estima tokens; nada de tasa
// instantánea: seis ventanas móviles (5s, 15s, 30s, 1m, 5m, 15m).
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const app = join(import.meta.dirname, '..', 'dist-ts', 'app');
const origin = 'http://tps-fixture.invalid';
const browser = await chromium.launch();
let checks = 0;
const eq = (a, b, que) => { if (a !== b) throw new Error(que + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); checks++; };
const ok = (v, que) => { if (!v) throw new Error(que); checks++; };
try {
  const ctx = await browser.newContext({ viewport: { width: 411, height: 777 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(e.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'tps-fixture.invalid') return route.abort();
    if (url.pathname === '/config.js') {
      return route.fulfill({ contentType: 'application/javascript', body: "window.__AEGIS_APP__={acpUrl:'ws://tps-fixture.invalid/acp',cwd:'/mock',host:'mock'};" });
    }
    if (url.pathname === '/client-log') return route.fulfill({ status: 204, body: '' });
    if (url.pathname.startsWith('/changes.json')) return route.fulfill({ json: { kind: 'not-git', entries: [], truncated: false } });
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = join(app, rel);
    if (!existsSync(file)) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'no' });
    return route.fulfill({ path: file });
  });
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__aegisWeb?.testUi, null, { timeout: 20000 });

  const medir = () => page.evaluate(() => {
    const row = document.querySelector('#runbar-speed-windows');
    return {
      cells: [...document.querySelectorAll('#runbar-speed-windows .runbar-speed-cell')].map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim()),
      hidden: row?.hidden ?? null,
      display: row ? getComputedStyle(row).display : null,
      instant: !!document.querySelector('#runbar-tps') || !!document.querySelector('#runbar-avg'),
      title: row?.getAttribute('title') ?? null
    };
  });
  const S = 'sesion-tps';

  // 1) Turno en curso, texto entrando, sin usage: seis ventanas vacías, ningún número inventado.
  await page.evaluate((sid) => {
    const app = window.__aegisWeb;
    app.state.current = { id: String(sid), title: 'prueba', cwd: '/mock', configOptions: [] };
    document.querySelector('#welcome')?.remove();
    app.speedStart();
    app.testUi.busy(true, 'Turno en curso');
    app.testUi.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'x'.repeat(400) } } });
  }, S);
  await page.waitForTimeout(300);
  const sinUso = await medir();
  eq(sinUso.cells.length, 6, 'seis ventanas desde el arranque');
  ok(sinUso.cells.every((x) => x.endsWith('—')), 'sin usage no hay número: ' + JSON.stringify(sinUso.cells));
  ok(!sinUso.hidden && sinUso.display !== 'none', 'la fila se ve aunque no haya datos: ' + JSON.stringify(sinUso));
  ok(!sinUso.instant, 'no existe badge de tasa instantánea');
  ok((sinUso.title || '').includes('usage de salida'), 'el title explica qué falta: ' + String(sinUso.title));

  // 2) 36 outputTokens reportados hace menos de 5 s se cuentan enteros en cada ventana y se
  //    dividen por su ancho fijo: 36 / 5 = 7,2 · 36 / 15 = 2,4 · 36 / 30 = 1,2 · 36 / 60 = 0,6.
  await page.evaluate((sid) => {
    window.__aegisWeb.testUi.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: 'm1', usage: { outputTokens: 36, elapsedMs: 2200, generationMs: 1200 } } });
  }, S);
  await page.waitForTimeout(250);
  const gen = await medir();
  eq(gen.cells[0], '5s7.2', 'ventana de 5s: 36 outputTokens / 5 s');
  eq(gen.cells[1], '15s2.4', 'ventana de 15s: 36 / 15');
  eq(gen.cells[2], '30s1.2', 'ventana de 30s: 36 / 30');
  eq(gen.cells[3], '1m0.6', 'ventana de 1m: 36 / 60');
  eq(gen.cells[4], '5m0.1', 'ventana de 5m: 36 / 300 = 0,12');
  eq(gen.cells[5], '15m0.0', 'ventana de 15m: 36 / 900 = 0,04');

  // 3) Un message_usage válido se cuenta aunque el proveedor no haya informado generationMs.
  await page.evaluate((sid) => {
    const t = window.__aegisWeb.testUi;
    t.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'hola' } } });
    t.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: 'm2', usage: { outputTokens: 40, elapsedMs: 5000, generationMs: null } } });
  }, S);
  await page.waitForTimeout(250);
  eq((await medir()).cells[0], '5s15.2', 'ventana 5s: suma 36 + 40 outputTokens reportados');

  // 4) Sin timing, o con una solicitud menor a un segundo, el usage sigue alimentando ventanas.
  await page.evaluate((sid) => {
    const t = window.__aegisWeb.testUi;
    t.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm4', content: { type: 'text', text: 'sin timing' } } });
    t.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: 'm4', usage: { outputTokens: 17, generationMs: null, elapsedMs: null } } });
  }, S);
  await page.waitForTimeout(250);
  eq((await medir()).cells[0], '5s18.6', 'outputTokens cuenta aunque falten todos los tiempos');

  await page.evaluate((sid) => {
    const t = window.__aegisWeb.testUi;
    t.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm5', content: { type: 'text', text: 'paso breve' } } });
    t.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: 'm5', usage: { outputTokens: 9, elapsedMs: 250, generationMs: null } } });
  }, S);
  await page.waitForTimeout(250);
  eq((await medir()).cells[0], '5s20.4', 'outputTokens cuenta aunque elapsedMs sea menor a un segundo');


  // 5) Segundo paso medido: los tokens se suman y el promedio sube.
  await page.evaluate((sid) => {
    const t = window.__aegisWeb.testUi;
    t.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm3', content: { type: 'text', text: 'otro paso' } } });
    t.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: 'm3', usage: { outputTokens: 314, elapsedMs: 4200, generationMs: 3200 } } });
  }, S);
  await page.waitForTimeout(250);
  const dos = await medir();
  eq(dos.cells[0], '5s83.2', 'ventana 5s: (36 + 40 + 17 + 9 + 314) outputTokens / 5');
  eq(dos.cells[1], '15s27.7', 'ventana 15s: 416 outputTokens / 15');

  // 5) El texto visible no mueve el número: más chunks del mismo paso no cambian nada.
  const antesExtra = (await medir()).cells.join('|');
  await page.evaluate((sid) => {
    window.__aegisWeb.testUi.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm3', content: { type: 'text', text: 'y'.repeat(4000) } } });
  }, S);
  await page.waitForTimeout(400);
  eq((await medir()).cells.join('|'), antesExtra, 'el texto visible no altera los promedios');

  // 7) El runbar se limpia al cerrar el turno.
  await page.evaluate(() => { window.__aegisWeb.speedReset(); });
  await page.waitForTimeout(150);
  const limpio = await medir();
  ok(limpio.hidden || limpio.cells.length === 0, 'la fila se oculta al resetear: ' + JSON.stringify(limpio));

  eq(errores.length, 0, 'sin errores de página: ' + errores.join(' | '));
  await ctx.close();
  console.log('PASS promedios de salida solo con usage del backend (' + checks + ' comprobaciones)');
} finally {
  await browser.close();
}
