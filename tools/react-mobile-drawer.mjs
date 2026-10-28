// Abre el drawer de sesiones en móvil emulado y confirma que el sidebar entra en pantalla; en
// escritorio confirma que el botón de menú está oculto. Sólo lectura.
// Uso: node tools/react-mobile-drawer.mjs "http://127.0.0.1:3790/app-react/?acp=proxy"
import { chromium, devices } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3790/app-react/?acp=proxy';
const MENU = 'Abrir menú de sesiones';
const browser = await chromium.launch();

const x = (page) =>
  page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar');
    const box = sidebar ? sidebar.getBoundingClientRect() : null;
    return box ? Math.round(box.x) : null;
  });

const movil = async (nombre, opciones) => {
  const context = await browser.newContext(opciones);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.composer', { timeout: 30000 });
  const antes = await x(page);
  const boton = page.getByRole('button', { name: MENU });
  const botonVisible = (await boton.count()) > 0 && (await boton.isVisible());
  if (botonVisible) await boton.click();
  await page.waitForTimeout(350);
  const abierto = await x(page);
  //
  const sinDesborde = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await context.close();
  return { dispositivo: nombre, botonVisible, sidebarAntes: antes, sidebarDespues: abierto, sinDesbordeHorizontal: sinDesborde };
};

const escritorio = async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.composer', { timeout: 30000 });
  const boton = page.getByRole('button', { name: MENU });
  const visible = (await boton.count()) > 0 && (await boton.isVisible());
  const sidebar = await x(page);
  await context.close();
  return { dispositivo: 'Escritorio 1280', botonMenuVisible: visible, sidebar: sidebar };
};

try {
  const salida = [await movil('Pixel 7', devices['Pixel 7']), await movil('iPhone 12', devices['iPhone 12']), await escritorio()];
  console.log(JSON.stringify(salida, null, 2));
} catch (error) {
  console.log(JSON.stringify({ fallo: String(error && error.message) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
