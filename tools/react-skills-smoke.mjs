// Abre el panel de Skills en el cliente React y cuenta lo que lista. Sólo lectura: no crea ni borra.
// Uso: node tools/react-skills-smoke.mjs "http://127.0.0.1:3790/app-react/?acp=proxy"
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3790/app-react/?acp=proxy';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar', { timeout: 20000 });
  await page.keyboard.press('Control+Shift+p');
  const paleta = page.getByPlaceholder(/Buscar|comando/i).first();
  await paleta.waitFor({ timeout: 15000 });
  await paleta.fill('skills');
  const opcion = page.getByRole('option', { name: /Skills/i }).first();
  await opcion.click();
  await page.waitForSelector('.skills', { timeout: 20000 });
  await page.waitForFunction(() => (document.querySelectorAll('.skills-list li').length ?? 0) > 0, { timeout: 30000 });
  const items = await page.$$eval('.skills-list li', (nodes) => nodes.length);
  const primera = await page.locator('.skills-list li button').first().innerText();
  const cuenta = await page.locator('.skills-list .muted').first().innerText();
  await page.locator('.skills-list li button').first().click();
  await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Contenido de la skill"]')?.value?.length ?? 0) > 0, {
    timeout: 15000,
  });
  const contenido = await page.locator('textarea[aria-label="Contenido de la skill"]').inputValue();
  console.log(JSON.stringify({ items, primera: primera.split('\n')[0], cuenta, contenidoChars: contenido.length, errores: errors }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ fallo: String(error && error.message), errores: errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
