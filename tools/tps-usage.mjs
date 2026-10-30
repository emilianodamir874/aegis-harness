// Los promedios de salida del runbar se miden SOLO con usage del backend: outputTokens y el
// tiempo que informa el provider. Nada de estimar por caracteres visibles, y nada de tasa
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
      title: row?.querySelector('.runbar-speed-cell')?.getAttribute('title') ?? null
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
  ok((sinUso.title || '').includes('últimos 5s'), 'el title dice qué mide: ' + String(sinUso.title));

  // 2) generationMs: 36 tokens en 1,2 s entran completos en la ventana de 5 s y se diluyen en el
  //    resto: 36 / 5 = 7,2 · 36 / 15 = 2,4 · 36 / 30 = 1,2 · 36 / 60 = 0,6 · 36 / 300 = 0,1 · 36 / 900 = 0,0.
  await page.evaluate((sid) => {
    window.__aegisWeb.testUi.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: 'm1', usage: { outputTokens: 36, elapsedMs: 2200, generationMs: 1200 } } });
  }, S);
  await page.waitForTimeout(250);
  const gen = await medir();
  eq(gen.cells[0], '5s7.2', 'ventana de 5s: 36 tok enteros / 5 s');
  eq(gen.cells[1], '15s2.4', 'ventana de 15s: 36 / 15');
  eq(gen.cells[2], '30s1.2', 'ventana de 30s: 36 / 30');
  eq(gen.cells[3], '1m0.6', 'ventana de 1m: 36 / 60');
  eq(gen.cells[4], '5m0.1', 'ventana de 5m: 36 / 300 = 0,12');
  eq(gen.cells[5], '15m0.0', 'ventana de 15m: 36 / 900 = 0,04');

  // 3) Throughput de solicitud (sin generationMs) NO entra en las ventanas: incluye TTFT y cola.
  await page.evaluate((sid) => {
    const t = window.__aegisWeb.testUi;
    t.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'hola' } } });
    t.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: 'm2', usage: { outputTokens: 40, elapsedMs: 5000, generationMs: null } } });
  }, S);
  await page.waitForTimeout(250);
  eq((await medir()).cells[0], '5s7.2', 'la solicitud completa no contamina el promedio de generación');

  // 4) Segundo paso medido: los tokens se suman y el promedio sube.
  await page.evaluate((sid) => {
    const t = window.__aegisWeb.testUi;
    t.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm3', content: { type: 'text', text: 'otro paso' } } });
    t.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: 'm3', usage: { outputTokens: 314, elapsedMs: 4200, generationMs: 3200 } } });
  }, S);
  await page.waitForTimeout(250);
  const dos = await medir();
  eq(dos.cells[0], '5s70.0', '36 + 314 tok / 5 s = 70');
  eq(dos.cells[1], '15s23.3', '350 / 15 = 23,3');

  // 5) El texto visible no mueve el número: más chunks del mismo paso no cambian nada.
  const antesExtra = (await medir()).cells.join('|');
  await page.evaluate((sid) => {
    window.__aegisWeb.testUi.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm3', content: { type: 'text', text: 'y'.repeat(4000) } } });
  }, S);
  await page.waitForTimeout(400);
  eq((await medir()).cells.join('|'), antesExtra, 'el texto visible no altera los promedios');

  // 6) El runbar se limpia al cerrar el turno.
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
