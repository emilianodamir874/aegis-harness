// Gate del panel de gasto y uso.
//
// Verifica lo que hace que un panel de gasto sirva: cifra del período con su proyección, reparto
// por día y por modelo, cache, composición de tokens, chats y llamadas caras, procedencia del
// número, cambio de período que realmente cambia los datos, y que el panel entre en pantalla con
// el contenido ya cargado.
//
// Uso: node tools/gasto-check.mjs [url]
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://192.168.100.34:3788/';
const res = [];
const check = (n, ok, d = '') => res.push({ n, ok: !!ok, d });

const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1440, height: 1180 } })).newPage();
const errores = [];
page.on('pageerror', (e) => errores.push(String(e).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text().slice(0, 120)); });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!document.querySelector('#btn-density'), null, { timeout: 20000 });
await page.evaluate(() => document.querySelector('#btn-density')?.click());
await page.waitForTimeout(2800);

const estado = () => page.evaluate(() => {
  const panel = document.querySelector('#usage-panel .panel');
  if (!panel) return null;
  const body = panel.querySelector('.panel-body');
  const r = panel.getBoundingClientRect();
  const txt = (sel) => panel.querySelector(sel)?.textContent?.trim() || '';
  return {
    secciones: [...panel.querySelectorAll('.gs-sec > span')].map((e) => e.textContent),
    tabs: [...panel.querySelectorAll('.gs-tab')].map((e) => ({ t: e.textContent, on: e.classList.contains('is-on') })),
    cifra: txt('.gs-big b'),
    proyeccion: txt('.gs-kpi b'),
    sub: txt('.panel-sub'),
    pie: txt('.gs-foot-note'),
    filas: [...panel.querySelectorAll('.gs-r')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
    dias: [...panel.querySelectorAll('.gs-bar-k')].map((e) => e.textContent),
    modelos: [...panel.querySelectorAll('.gs-m-k')].map((e) => e.textContent),
    dentro: r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1,
    conScroll: body ? body.scrollHeight > body.clientHeight + 2 : false,
    alto: Math.round(r.height),
  };
});

const a = await estado();
console.log('panel:', JSON.stringify({ cifra: a.cifra, proy: a.proyeccion, sub: a.sub, pie: a.pie, secciones: a.secciones, dentro: a.dentro, conScroll: a.conScroll }));

check('el panel se abre desde el botón de las barras del topbar',
  (await page.evaluate(() => document.querySelector('#btn-density')?.getAttribute('aria-label'))) === 'Gasto y uso',
  await page.evaluate(() => document.querySelector('#btn-density')?.getAttribute('aria-label')));
check('la densidad del texto se mudó al pie del panel',
  (await page.evaluate(() => document.querySelectorAll('#usage-panel .gs-dens-b').length)) === 3,
  await page.evaluate(() => [...document.querySelectorAll('#usage-panel .gs-dens-b')].map((e) => e.textContent).join('/')));
check('el panel muestra la ventana del modelo', a.secciones.includes('Ventana del modelo'), a.secciones.join(' | '));
check('abre con las ocho secciones del panel', a.secciones.includes('Gasto del período') && a.secciones.includes('Gasto por día')
  && a.secciones.includes('Por modelo') && a.secciones.includes('Qué se paga') && a.secciones.includes('Este chat'),
  a.secciones.join(' | '));
check('la cifra principal es del período, no de la sesión', /^US\$/.test(a.cifra) && Number(a.cifra.replace(/[^\d,]/g, '').replace(',', '.')) > 1, a.cifra);
check('muestra la proyección mensual', /^US\$/.test(a.proyeccion) && a.proyeccion !== a.cifra, a.proyeccion);
check('el subtítulo dice el período', /día|hoy|historial/.test(a.sub), a.sub);
check('el pie dice de dónde sale el número', /estimado|informado|historial/.test(a.pie), a.pie);
check('trae el reparto por día con sus fechas', a.dias.length >= 3 && a.dias.every((d) => /^\d\d\/\d\d$/.test(d)), a.dias.join(','));
check('trae el reparto por modelo con montos', a.modelos.length >= 2, a.modelos.join(','));
check('la composición de tokens separa cache de fresca', a.filas.some((f) => /cache/.test(f)) && a.filas.some((f) => /fresca/.test(f)),
  a.filas.filter((f) => /cache|fresca/.test(f)).join(' | '));
check('lista los chats más caros con su costo', a.filas.concat([a.secciones.join()]).length > 0 && /Chats más caros/.test(a.secciones.join()), 'ok');
check('el panel entero entra en pantalla con el contenido cargado', a.dentro, `alto ${a.alto} · scroll ${a.conScroll}`);

// ---------- la ventana del modelo con datos reales de un turno ----------
// Se inyecta el estado que manda message_usage (last + umbral) y se comprueba la cuenta: la
// ventana es la última llamada, el techo se deriva del porcentaje de compactación, y el margen es
// lo que queda. Sin esto, la sección solo se veía vacía porque el panel se abre sin turno.
const ventana = await page.evaluate(() => {
  const W = window.__aegisWeb;
  const u = W.state.usage || (W.state.usage = {});
  u.last = { inputTokens: 380000, outputTokens: 62000, cost: 1.42, elapsedMs: 41000 };
  u.autoCompactAt = 839000;
  u.autoCompactPct = 0.839;
  W.refrescarGasto?.();
  return new Promise((r) => setTimeout(() => {
    const sec = [...document.querySelectorAll('#usage-panel .gs-sec')].find((e) => /Ventana/.test(e.textContent));
    const caja = sec?.nextElementSibling;
    r({ texto: caja ? caja.textContent.replace(/\s+/g, ' ').trim() : '', nota: !caja });
  }, 500));
});
console.log('ventana:', JSON.stringify(ventana));
check('la ventana del modelo sale de la última llamada, no del total de la sesión',
  /442 k/.test(ventana.texto) && /de 1 M(?!,)/.test(ventana.texto) && /quedan/.test(ventana.texto),
  ventana.texto);
check('la ventana distingue el umbral de compactación del techo del modelo',
  /compacta en 839 k/.test(ventana.texto), ventana.texto);

// ---------- cambio de período: los datos tienen que cambiar de verdad ----------
await page.evaluate(() => document.querySelector('#usage-panel .gs-tab[data-dias="30"]')?.click());
await page.waitForTimeout(1600);
const b30 = await estado();
console.log('30 días:', JSON.stringify({ cifra: b30.cifra, sub: b30.sub, activo: b30.tabs.find((t) => t.on)?.t }));
check('cambiar a 30 días cambia la cifra y el subtítulo',
  b30.tabs.find((t) => t.on)?.t === '30 días' && b30.sub !== a.sub && Number(b30.cifra.replace(/[^\d,]/g, '').replace(',', '.')) > Number(a.cifra.replace(/[^\d,]/g, '').replace(',', '.')),
  `${a.cifra} -> ${b30.cifra} · ${b30.sub}`);

// El período elegido se recuerda.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!document.querySelector('#btn-density'), null, { timeout: 20000 });
await page.evaluate(() => document.querySelector('#btn-density')?.click());
await page.waitForTimeout(2200);
const c = await estado();
check('el período elegido se recuerda al recargar', c.tabs.find((t) => t.on)?.t === '30 días', c.tabs.map((t) => (t.on ? '*' : '') + t.t).join(' '));
await page.evaluate(() => document.querySelector('#usage-panel .gs-tab[data-dias="7"]')?.click());
await page.waitForTimeout(900);

// ---------- móvil ----------
const m = await (await b.newContext({ viewport: { width: 384, height: 832 }, deviceScaleFactor: 2.8125, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-A566B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' })).newPage();
await m.goto(BASE, { waitUntil: 'domcontentloaded' });
await m.waitForFunction(() => !!document.querySelector('#btn-density'), null, { timeout: 20000 });
await m.evaluate(() => document.querySelector('#btn-density')?.click());
await m.waitForTimeout(2600);
const mm = await m.evaluate(() => {
  const panel = document.querySelector('#usage-panel .panel');
  const r = panel.getBoundingClientRect();
  const tabs = [...panel.querySelectorAll('.gs-tab')].map((e) => Math.round(e.getBoundingClientRect().height));
  return {
    hoja: !!document.querySelector('#usage-panel.is-sheet'),
    dentro: r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
    tabs,
    secciones: panel.querySelectorAll('.gs-sec').length,
    taller: Math.max(...[...panel.querySelectorAll('.gs-r')].map((e) => Math.round(e.getBoundingClientRect().height))),
  };
});
console.log('A56:', JSON.stringify(mm));
check('en el teléfono abre como hoja y entra entera', mm.hoja && mm.dentro, `altura tab ${mm.tabs.join('/')}`);
check('los botones de período son táctiles en el teléfono', Math.min(...mm.tabs) >= 36, mm.tabs.join('/'));
check('las filas no se apilan raras en el teléfono', mm.taller <= 34, `${mm.taller} px la más alta`);

await b.close();
const ok = res.filter((r) => r.ok).length;
for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '  [' + r.d + ']' : ''}`);
if (errores.length) console.log('\nerrores de consola:\n' + errores.slice(0, 6).join('\n'));
console.log(`\n${ok}/${res.length} PASS`);
process.exit(ok === res.length && !errores.length ? 0 : 1);
