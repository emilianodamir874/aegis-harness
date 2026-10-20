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
    const ov = document.getElementById('st-overlay') as HTMLElement;
    const b = document.getElementById('st-box') as HTMLElement;
    return {
      open: ov.dataset.open,
      kpis: document.querySelectorAll('.st-kpi').length,
      boxW: Math.round(b.getBoundingClientRect().width),
      boxScrollW: b.scrollWidth,
      close: !!document.getElementById('st-close'),
      rows: document.querySelectorAll('table.st-t tr').length,
    };
  });
  check(panel.open === '1', 'panel abierto');
  check(panel.kpis === 6, '6 KPIs (vio ' + panel.kpis + ')');
  check(panel.boxW === 390 && panel.boxScrollW === 390, 'panel a pantalla completa sin desborde ' + JSON.stringify(panel));
  check(panel.close && panel.rows > 0, 'boton cerrar y filas cargadas');

  // scrollear y cerrar con el ✕ fijo
  await page.evaluate(() => (document.getElementById('st-box') as HTMLElement).scrollTo(0, 2400));
  await page.waitForTimeout(400);
  const x = await page.evaluate(() => {
    const r = (document.getElementById('st-close') as HTMLElement).getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), visible: r.y >= 0 && r.y < window.innerHeight };
  });
  check(x.visible, 'el ✕ sigue visible al scrollear (y=' + x.y + ')');
  await page.touchscreen.tap(x.x, x.y);
  await page.waitForTimeout(600);
  const closed = await page.evaluate(() => (document.getElementById('st-overlay') as HTMLElement).dataset.open);
  check(closed === '0', 'el ✕ cierra el panel');
  check(errs.length === 0, 'sin errores de pagina: ' + JSON.stringify(errs));
  check(bad.length === 0, 'sin HTTP >= 400: ' + JSON.stringify(bad.slice(0, 4)));
  pass('UI movil 390x844 contra ' + url);
} finally {
  await browser.close();
}
