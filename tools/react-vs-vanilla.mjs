// Compara el cliente React contra el cliente actual con las mismas métricas y en la misma máquina.
// Sólo lectura: no envía prompts ni toca permisos. Espera dos URLs servidas por la misma instancia.
// Uso: node tools/react-vs-vanilla.mjs http://127.0.0.1:3791/ "http://127.0.0.1:3791/app-react/?acp=proxy"
import { chromium } from 'playwright';

const [vanillaUrl, reactUrl] = process.argv.slice(2);
if (!vanillaUrl || !reactUrl) {
  console.error('faltan URLs: node tools/react-vs-vanilla.mjs <vanilla> <react>');
  process.exit(2);
}

const browser = await chromium.launch();

const medir = async (url, selectorListo) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errores = [];
  page.on('pageerror', (error) => errores.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errores.push(msg.text().slice(0, 160));
  });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(selectorListo, { timeout: 30000 });
  const listo = Date.now() - t0;
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return {
      nodos: document.querySelectorAll('*').length,
      fcpMs: fcp ? Math.round(fcp.startTime) : null,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadMs: nav ? Math.round(nav.loadEventEnd) : null,
      transferidos: performance.getEntriesByType('resource').length,
      bytes: performance.getEntriesByType('resource').reduce((sum, r) => sum + (r.transferSize || 0), 0),
      memoriaMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    };
  });
  // Un scroll hacia arriba y una tecla: interacción mínima, sin tocar el motor.
  await page.mouse.wheel(0, -400);
  await page.keyboard.press('Escape');
  await context.close();
  return { listoMs: listo, errores, ...metrics };
};

try {
  const vanilla = await medir(vanillaUrl, '#sidebar, .sidebar');
  const react = await medir(reactUrl, '.sidebar');
  console.log(JSON.stringify({ vanilla, react }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ fallo: String(error && error.message) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
