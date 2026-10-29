// Gate del teclado del teléfono.
//
// En Android el teclado no dispara 'resize' del layout: recorta el visualViewport. El .app se
// achica pero el transcript se queda con el scroll viejo, y uno termina escribiendo a ciegas con
// el final de la conversación fuera de vista. Este gate simula el teclado achicando el viewport
// (384x832 -> 384x470) y mide la distancia al fondo.
//
// Uso: node tools/teclado-check.mjs [url]
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://192.168.100.34:3788/';
const res = [];
const check = (n, ok, d = '') => res.push({ n, ok: !!ok, d });

const b = await chromium.launch();
const page = await (await b.newContext({
  viewport: { width: 384, height: 832 },
  deviceScaleFactor: 2.8125,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-A566B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
})).newPage();
const errores = [];
page.on('pageerror', (e) => errores.push(String(e).slice(0, 140)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__aegisWeb?.feed, null, { timeout: 20000 });
await page.waitForTimeout(800);

// transcript largo
await page.evaluate(() => {
  const W = window.__aegisWeb;
  const inner = document.querySelector('#msg-inner');
  if (inner) inner.innerHTML = '';
  W.state.msgs.clear();
  for (let i = 0; i < 12; i++) W.feed('m' + i, 'Mensaje ' + i + ' del transcript para llenar la pantalla. '.repeat(4), false);
});
const fondo = () => page.evaluate(() => {
  const m = document.querySelector('#messages');
  return { px: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight), alto: Math.round(m.clientHeight), app: Math.round(document.querySelector('.app').getBoundingClientRect().height) };
});

await page.evaluate(() => { const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; });
await page.waitForTimeout(500);
const antes = await fondo();
check('el transcript arranca pegado al fondo', antes.px <= 8, JSON.stringify(antes));

// teclado abierto
await page.setViewportSize({ width: 384, height: 470 });
await page.waitForTimeout(900);
const abierto = await fondo();
check('con el teclado abierto el transcript sigue en el final',
  abierto.px <= 8, `quedó a ${abierto.px} px del fondo · alto ${abierto.alto} · app ${abierto.app}`);
check('el área útil se achica con el teclado (no queda tapada)',
  abierto.app <= 480 && abierto.alto < antes.alto, JSON.stringify(abierto));

// teclado cerrado
await page.setViewportSize({ width: 384, height: 832 });
await page.waitForTimeout(700);
const cerrado = await fondo();
check('al cerrar el teclado vuelve a quedar en el final', cerrado.px <= 8, JSON.stringify(cerrado));

// Si estaba leyendo más arriba, abrir el teclado lo baja (es intención de escribir), pero cerrarlo
// no debe devolverlo a un lugar arbitrario.
await page.evaluate(() => { const m = document.querySelector('#messages'); m.scrollTop = Math.round(m.scrollHeight * 0.35); });
await page.waitForTimeout(300);
const arriba = await fondo();
await page.setViewportSize({ width: 384, height: 470 });
await page.waitForTimeout(900);
const arribaTeclado = await fondo();
await page.setViewportSize({ width: 384, height: 832 });
await page.waitForTimeout(700);
const arribaCerrado = await fondo();
console.log('leyendo arriba:', JSON.stringify({ arriba, arribaTeclado, arribaCerrado }));
check('abrir el teclado mientras se lee algo más arriba lleva al final',
  arribaTeclado.px <= 8, `quedó a ${arribaTeclado.px} px`);
check('cerrar el teclado no salta a un lugar raro del transcript',
  arribaCerrado.px <= 60, `quedó a ${arribaCerrado.px} px`);

await b.close();
for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '  [' + r.d + ']' : ''}`);
if (errores.length) console.log('\nerrores de consola:\n' + errores.slice(0, 5).join('\n'));
const ok = res.filter((r) => r.ok).length;
console.log(`\n${ok}/${res.length} PASS`);
process.exit(ok === res.length && !errores.length ? 0 : 1);
