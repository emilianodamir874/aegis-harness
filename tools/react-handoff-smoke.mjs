// Smoke del handoff: abre la app, dispara Ctrl+Alt+H, espera el bloque generado y lo describe.
// Sólo lee: exporta la sesión origen con session/export (lectura) y no envía nada al motor.
// Uso: node tools/react-handoff-smoke.mjs "http://127.0.0.1:3790/app-react/?acp=proxy"
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
  await page.keyboard.press('Control+Alt+h');
  const area = page.getByLabel('Bloque de handoff');
  await area.waitFor({ timeout: 15000 });
  await page.waitForFunction(
    () => {
      const node = document.querySelector('textarea[aria-label="Bloque de handoff"]');
      return Boolean(node && node.value.includes('## Handoff'));
    },
    { timeout: 90000 },
  );
  const block = await area.inputValue();
  const status = await page.locator('.row-actions .muted').first().innerText();
  const insertar = page.getByRole('button', { name: 'Insertar en el composer' });
  await insertar.click();
  await page.waitForFunction(
    () => Boolean(document.querySelector('.composer textarea')?.value.includes('## Handoff')),
    { timeout: 15000 },
  );
  const composer = await page.locator('.composer textarea').first().inputValue();
  console.log(
    JSON.stringify(
      {
        bloqueChars: block.length,
        secciones: block.split('\n').filter((line) => line.startsWith('### ')),
        estado: status,
        composerChars: composer.length,
        composerTieneHandoff: composer.includes('## Handoff'),
        errores: errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(JSON.stringify({ fallo: String(error && error.message), errores: errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
