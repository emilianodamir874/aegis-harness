// Mide el cliente React con viewport y user-agent de teléfono. Es EMULACIÓN: no es Android físico y
// no mide latencia de túnel. Revisa desbordes horizontales, el drawer, el composer y los errores.
// Uso: node tools/react-mobile-smoke.mjs "http://127.0.0.1:3790/app-react/?acp=proxy"
import { chromium, devices } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3790/app-react/?acp=proxy';
const browser = await chromium.launch();

const medir = async (nombre, opciones) => {
  const context = await browser.newContext(opciones);
  const page = await context.newPage();
  const errores = [];
  page.on('pageerror', (error) => errores.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errores.push(msg.text().slice(0, 140));
  });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar, .drawer-toggle, [aria-label="Abrir sesiones"]', { timeout: 30000 });
  const listoMs = Date.now() - t0;
  const layout = await page.evaluate(() => {
    const doc = document.documentElement;
    const composer = document.querySelector('.composer');
    const sidebar = document.querySelector('.sidebar');
    const visible = (node) => Boolean(node && node.getBoundingClientRect().width > 0);
    return {
      anchoVentana: window.innerWidth,
      scrollAncho: doc.scrollWidth,
      desborde: doc.scrollWidth > window.innerWidth + 1,
      sidebarVisible: visible(sidebar),
      composerVisible: visible(composer),
      composerAlto: composer ? Math.round(composer.getBoundingClientRect().height) : null,
      tapTargets: [...document.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().width < 28).length,
      nodos: document.querySelectorAll('*').length,
    };
  });
  // Abrir el drawer si el sidebar no está visible: es el camino en móvil.
  let drawerAbrio = null;
  if (!layout.sidebarVisible) {
    const toggle = page.locator('[aria-label="Abrir sesiones"], .drawer-toggle').first();
    if (await toggle.count()) {
      await toggle.click();
      await page.waitForTimeout(250);
      drawerAbrio = await page.evaluate(() => {
        const sidebar = document.querySelector('.sidebar');
        return Boolean(sidebar && sidebar.getBoundingClientRect().width > 0);
      });
    }
  }
  // Scroll del transcript para ver si el gesto funciona en el contenedor correcto.
  const scroll = await page.evaluate(() => {
    const scroller = document.querySelector('.scroll');
    if (!scroller) return null;
    const antes = scroller.scrollTop;
    scroller.scrollTop = Math.max(0, antes - 400);
    return { antes, despues: scroller.scrollTop };
  });
  await context.close();
  return { dispositivo: nombre, listoMs, ...layout, drawerAbrio, scroll, errores };
};

const resultados = [];
try {
  resultados.push(await medir('Pixel 7 (emulado)', devices['Pixel 7']));
  resultados.push(await medir('iPhone 12 (emulado)', devices['iPhone 12']));
} catch (error) {
  resultados.push({ fallo: String(error && error.message) });
  process.exitCode = 1;
} finally {
  await browser.close();
}
console.log(JSON.stringify(resultados, null, 2));
