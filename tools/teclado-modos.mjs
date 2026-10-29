// Gate de los TRES modos de teclado de Android. Existe porque el gate anterior (teclado-check)
// simulaba el teclado achicando el viewport de layout, que es exactamente el modo que NO falla
// en el teléfono: daba verde en falso. Acá se prueban los tres modos por separado.
//
//   modo 2 · resizes-content : el layout se achica (lo que hacía teclado-check)
//   modo 1 · resize-visual   : el layout NO cambia, baja visualViewport.height  <-- el que falla
//   modo 3 · nada de nada    : no cambia ninguna medida, el teclado se dibuja encima
//
// Uso: node tools/teclado-modos.mjs [url]
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:3788/';
const ANCHO = 411, ALTO = 777; // Galaxy A56: 1080x2340 con DPR 2.625
const res = [];
const check = (n, ok, d = '') => res.push({ n, ok: !!ok, d: String(d) });

const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: ANCHO, height: ALTO },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
});
const page = await ctx.newPage();
const errores = [];
page.on('pageerror', (e) => errores.push(String(e).slice(0, 200)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__aegisWeb?.feed, null, { timeout: 20000 });
await page.waitForTimeout(600);

// Transcript largo para que el anclaje al fondo sea medible.
await page.evaluate(() => {
  const W = window.__aegisWeb;
  const inner = document.querySelector('#msg-inner');
  if (inner) inner.innerHTML = '';
  for (let i = 0; i < 14; i++) W.feed('k' + i, 'Mensaje ' + i + ' del transcript para llenar la pantalla. '.repeat(4), false);
  const m = document.querySelector('#messages');
  m.scrollTop = m.scrollHeight;
});
await page.waitForTimeout(300);

const geo = () => page.evaluate(() => {
  const app = document.querySelector('.app');
  const r = app.getBoundingClientRect();
  const c = document.querySelector('.composer-wrap').getBoundingClientRect();
  const vv = window.visualViewport;
  const cs = getComputedStyle(app);
  return {
    app: Math.round(r.height), appTop: Math.round(r.top),
    teclado: Math.round(parseFloat(cs.getPropertyValue('--mobile-teclado')) || 0),
    compBottom: Math.round(c.bottom),
    vvBottom: Math.round((vv?.height ?? innerHeight) + (vv?.offsetTop ?? 0)),
    layout: document.documentElement.clientHeight,
    dentroDelAncho: c.left >= 0 && c.right <= innerWidth + 0.5,
  };
});

// ---------- modo 2: el navegador achica el layout ----------
await page.evaluate(() => document.getElementById('input').focus());
await page.setViewportSize({ width: ANCHO, height: 470 });
await page.waitForTimeout(400);
let g = await geo();
check('modo 2: el área útil sigue al layout', g.app <= 480 && g.app >= 440, JSON.stringify(g));
check('modo 2: el composer queda dentro de la parte visible', g.compBottom <= g.vvBottom + 1, `${g.compBottom} <= ${g.vvBottom}`);
check('modo 2: no se estima teclado de más', g.teclado === 0, `--mobile-teclado=${g.teclado}`);

await page.setViewportSize({ width: ANCHO, height: ALTO });
await page.waitForTimeout(400);
g = await geo();
check('modo 2: al cerrar vuelve el alto completo', g.app >= ALTO - 6, JSON.stringify(g));

// ---------- modo 1: baja visualViewport, el layout NO cambia ----------
// Se congela visualViewport.height en 470 y se dispara su evento resize, con el layout intacto.
await page.evaluate(() => {
  const vv = window.visualViewport;
  window.__vvFake = 470;
  Object.defineProperty(vv, 'height', { configurable: true, get: () => window.__vvFake });
  Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
  vv.dispatchEvent(new Event('resize'));
});
await page.evaluate(() => document.getElementById('input').focus());
await page.waitForTimeout(500);
g = await geo();
check('modo 1: el área útil baja a lo que reporta visualViewport', Math.abs(g.app - 470) <= 6, JSON.stringify(g));
check('modo 1: el composer no queda debajo del teclado', g.compBottom <= g.vvBottom + 1, `${g.compBottom} <= ${g.vvBottom}`);
check('modo 1: el layout no se tocó', g.layout === ALTO, `layout=${g.layout}`);

await page.evaluate(() => {
  window.__vvFake = 777;
  window.visualViewport.dispatchEvent(new Event('resize'));
});
await page.waitForTimeout(400);
g = await geo();
check('modo 1: al cerrar vuelve el alto completo', g.app >= ALTO - 6, JSON.stringify(g));

// ---------- modo 1b: el navegador panea el viewport visual (offsetTop > 0) ----------
// Es lo que hace Chrome al enfocar un campo con el teclado abierto: además de recortar, mueve
// el área visible. Si el .app no se corre con ese paneo, el composer queda arriba o debajo de
// la banda visible según el caso. Acá el layout sigue midiendo 777.
await page.evaluate(() => {
  const vv = window.visualViewport;
  window.__vvFake = 470;
  window.__topFake = 200;
  Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => window.__topFake });
  vv.dispatchEvent(new Event('resize'));
});
await page.waitForTimeout(400);
g = await geo();
check('modo 1b: el área útil se corre con el paneo del navegador', Math.abs(g.appTop - 200) <= 6, JSON.stringify(g));
check('modo 1b: el composer queda justo arriba del teclado', Math.abs(g.compBottom - (470 + 200)) <= 8, `${g.compBottom} vs ${470 + 200}`);
await page.evaluate(() => {
  window.__vvFake = 777; window.__topFake = 0;
  window.visualViewport.dispatchEvent(new Event('resize'));
});
await page.waitForTimeout(300);

// ---------- modo 3: el navegador no reporta NADA ----------
// Página nueva: el "modo real" se memoriza por página a propósito (si el navegador ya demostró
// que reporta el teclado, no se estima nunca), así que acá hay que arrancar de cero.
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__aegisWeb?.feed, null, { timeout: 20000 });
await page.waitForTimeout(500);
await page.evaluate(() => {
  const vv = window.visualViewport;
  delete vv.height; delete vv.offsetTop;
  localStorage.removeItem('aegis.kb.alto');
});
await page.evaluate(() => document.getElementById('input').focus());
await page.waitForTimeout(900);
g = await geo();
check('modo 3: se estima el teclado cuando nadie lo reporta', g.teclado >= 180, `--mobile-teclado=${g.teclado}`);
check('modo 3: el área útil se recorta igual', g.app <= ALTO - 180, JSON.stringify(g));
check('modo 3: el composer queda arriba del borde inferior', g.compBottom <= g.app + 1, `${g.compBottom} <= ${g.app}`);
check('modo 3: el ancho del composer no se rompe', g.dentroDelAncho, JSON.stringify(g));

await page.evaluate(() => document.getElementById('input').blur());
await page.waitForTimeout(300);
g = await geo();
check('modo 3: al cerrar el teclado se libera la estimación', g.teclado === 0 && g.app >= ALTO - 6, JSON.stringify(g));

check('sin errores de página', errores.length === 0, errores.join(' | '));

await b.close();
for (const r of res) console.log((r.ok ? 'PASS  ' : 'FALLA ') + r.n + (r.d ? '  [' + r.d + ']' : ''));
const fallas = res.filter((r) => !r.ok).length;
console.log('\n' + (res.length - fallas) + '/' + res.length + (fallas ? ' FALLAN ' + fallas : ' PASS'));
process.exit(fallas ? 1 : 0);
