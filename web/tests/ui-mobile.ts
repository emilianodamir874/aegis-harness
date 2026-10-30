// Prueba de UI movil (390x844): el chat carga, no desborda y el panel "Gasto" abre y cierra.
// Read-only: no crea sesiones ni turnos.
import { chromium } from 'playwright';
import { baseUrl, check, pass, openPage } from './lib.js';

const url = baseUrl();
const browser = await chromium.launch({ headless: true });
try {
  const page = await openPage(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const errs: string[] = [];
  page.on('pageerror', (e: Error) => errs.push(e.message));
  const bad: string[] = [];
  page.on('response', (r: any) => {
    if (r.status() >= 400) bad.push(r.status() + ' ' + r.url());
  });

  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3500);

  const layout = await page.evaluate(() => ({
    vw: window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    skills: !!document.getElementById('btn-skills'),
    gastoIcon: !!document.getElementById('btn-gasto-top'),
    gastoDrawer: !!document.getElementById('btn-gasto'),
    input: !!document.querySelector('textarea,input'),
  }));
  check(layout.vw === 390, 'viewport 390 (vio ' + layout.vw + ')');
  check(layout.scrollW === 390, 'sin scroll horizontal (scrollWidth ' + layout.scrollW + ')');
  check(layout.skills && layout.gastoIcon && layout.input, 'controles presentes: ' + JSON.stringify(layout));
  check(!layout.gastoDrawer, 'el boton ancho "Gasto" del drawer ya no existe');

  // abrir el panel con un tap real
  const box = await page.evaluate(() => {
    const r = (document.getElementById('btn-gasto-top') as HTMLElement).getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await page.touchscreen.tap(box.x, box.y);
  await page.waitForTimeout(5000);
  const panel = await page.evaluate(() => {
    const root = document.getElementById('usage-panel') as HTMLElement;
    const b = root.querySelector('.panel-body') as HTMLElement;
    return {
      sheet: root.classList.contains('is-sheet'),
      body: !!b,
      big: (root.querySelector('.gs-big')?.textContent || '').replace(/\s+/g, ' ').trim(),
      tabs: root.querySelectorAll('.gs-tab').length,
      close: !!root.querySelector('.panel-x'),
      disclosure: root.querySelectorAll('.gs-disclosure').length,
      boxW: Math.round(root.getBoundingClientRect().width),
      boxScrollW: b ? b.scrollWidth : -1,
    };
  });
  check(panel.sheet && panel.body, 'el panel abre como hoja a pantalla completa en el teléfono: ' + JSON.stringify(panel));
  check(/US\$/.test(panel.big) && /llamadas/.test(panel.big), 'totales del período en el resumen: ' + panel.big);
  check(panel.tabs === 4, '4 pestañas de período (vio ' + panel.tabs + ')');
  check(panel.close && panel.disclosure >= 1, 'botón cerrar y desglose diferido presentes');
  check(panel.boxW === 390 && panel.boxScrollW <= 390, 'cuerpo sin desborde horizontal ' + JSON.stringify({ w: panel.boxW, sw: panel.boxScrollW }));

  // Cerrar con el ✕ del panel, tocando de verdad.
  const x = await page.evaluate(() => {
    const r = (document.querySelector('#usage-panel .panel-x') as HTMLElement).getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), visible: r.y >= 0 && r.y < window.innerHeight };
  });
  check(x.visible, 'el ✕ sigue visible con el panel abierto (y=' + x.y + ')');
  await page.touchscreen.tap(x.x, x.y);
  await page.waitForTimeout(600);
  const closed = await page.evaluate(() => !!document.getElementById('usage-panel'));
  check(!closed, 'el ✕ cierra el panel');
  check(errs.length === 0, 'sin errores de pagina: ' + JSON.stringify(errs));
  check(bad.length === 0, 'sin HTTP >= 400: ' + JSON.stringify(bad.slice(0, 4)));
  pass('UI movil 390x844 contra ' + url);
} finally {
  await browser.close();
}
