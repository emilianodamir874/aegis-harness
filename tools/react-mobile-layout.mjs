// ¿El sidebar está fuera de pantalla en móvil (drawer cerrado) y el main ocupa el ancho?
// Sólo lectura. Uso: node tools/react-mobile-layout.mjs "http://127.0.0.1:3790/app-react/?acp=proxy"
import { chromium, devices } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3790/app-react/?acp=proxy';
const browser = await chromium.launch();

const medir = async (nombre, opciones) => {
  const context = await browser.newContext(opciones);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.composer', { timeout: 30000 });
  const out = await page.evaluate(() => {
    const r = (sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { x: Math.round(box.x), w: Math.round(box.width), h: Math.round(box.height) };
    };
    return {
      viewport: window.innerWidth,
      sidebar: r('.sidebar'),
      main: r('.main'),
      composer: r('.composer'),
      hamburguesa: Boolean(document.querySelector('[aria-label="Abrir sesiones"], .drawer-toggle')),
      sidebarClase: document.querySelector('.sidebar')?.className ?? null,
    };
  });
  await context.close();
  return { dispositivo: nombre, ...out };
};

try {
  console.log(JSON.stringify([await medir('Pixel 7', devices['Pixel 7']), await medir('iPhone 12', devices['iPhone 12'])], null, 2));
} catch (error) {
  console.log(JSON.stringify({ fallo: String(error && error.message) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
