// La tasa de tok/s se mide SOLO con lo que reporta el backend (usage): nada de estimar por
// caracteres visibles. Este gate cubre los cuatro estados del badge del runbar.
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
    const el = document.querySelector('#runbar-tps');
    return { text: el?.textContent ?? null, title: el?.title ?? null, hidden: el?.hidden ?? null };
  });
  const S = 'sesion-tps';

  // 1) Turno en curso, texto entrando, sin usage: raya, y sin tilde en ningun lado.
  await page.evaluate((sid) => {
    const app = window.__aegisWeb;
    app.state.current = { id: String(sid), title: 'prueba', cwd: '/mock', configOptions: [] };
    document.querySelector('#welcome')?.remove();
    app.speedStart(); // arranca el medidor del run: sin esto el usage se descarta
    app.testUi.busy(true, 'Turno en curso');
    app.testUi.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'x'.repeat(400) } } });
  }, S);
  await page.waitForTimeout(200);
  const sinUso = await medir();
  eq(sinUso.text, '\u2014 tok/s', 'sin usage el badge no inventa una tasa');
  ok((sinUso.title || '').includes('Sin usage'), 'el title explica que falta el usage: ' + sinUso.title);
  ok(!(sinUso.title || '').includes('caracteres visibles'), 'no queda la promesa de estimar por texto');

  // 2) Llega generationMs: tasa de generacion medida por el backend.
  await page.evaluate((sid) => {
    window.__aegisWeb.testUi.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: 'm1', usage: { outputTokens: 36, elapsedMs: 2200, generationMs: 1200 } } });
  }, S);
  await page.waitForTimeout(150);
  const gen = await medir();
  ok(/30\.0 tok\/s/.test(gen.text || ''), 'generacion medida 36/1.2s = 30: ' + gen.text);
  ok(/medido por el backend/.test(gen.title || ''), 'el title dice quien midio: ' + gen.title);

  // 3) Solo elapsedMs: throughput de solicitud, nunca presentado como generacion.
  await page.evaluate((sid) => {
    const t = window.__aegisWeb.testUi;
    t.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'hola' } } });
    t.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: 'm2', usage: { outputTokens: 40, elapsedMs: 5000, generationMs: null } } });
  }, S);
  await page.waitForTimeout(150);
  const req = await medir();
  ok(/8\.0 tok\/s/.test(req.text || ''), 'solicitud 40/5s = 8: ' + req.text);
  ok(/no generaci/.test(req.title || ''), 'aclara que no es generacion: ' + req.title);

  // 4) Paso nuevo sin usage: se conserva la ultima medicion, rotulada como anterior.
  await page.evaluate((sid) => {
    window.__aegisWeb.testUi.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm3', content: { type: 'text', text: 'paso nuevo' } } });
  }, S);
  await page.waitForTimeout(150);
  const prev = await medir();
  ok(/^\u00falt/.test(prev.text || ''), 'paso sin usage muestra la ultima, no una estimacion: ' + prev.text);
  ok(!(prev.text || '').includes('~'), 'nunca aparece la tilde de estimado: ' + prev.text);

  // 5) El texto visible no mueve el numero: mas chunks del mismo paso no cambian la medicion.
  const antesExtra = (await medir()).text;
  await page.evaluate((sid) => {
    window.__aegisWeb.testUi.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm3', content: { type: 'text', text: 'y'.repeat(2000) } } });
  }, S);
  await page.waitForTimeout(200);
  eq((await medir()).text, antesExtra, 'el texto visible no altera la tasa');

  eq(errores.length, 0, 'sin errores de pagina: ' + errores.join(' | '));
  await ctx.close();
  console.log('PASS tok/s solo con usage del backend (' + checks + ' comprobaciones)');
} finally {
  await browser.close();
}
