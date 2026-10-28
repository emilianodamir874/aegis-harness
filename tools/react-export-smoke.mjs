// Smoke de exportación: abre un chat, usa el menú de la fila y verifica que el navegador reciba un
// archivo. Sólo llama session/export (lectura); no manda prompts ni toca permisos.
// Uso: node tools/react-export-smoke.mjs "http://127.0.0.1:3790/app-react/?acp=proxy"
import { chromium } from 'playwright';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:3790/app-react/?acp=proxy';
const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});

const dir = mkdtempSync(join(tmpdir(), 'aegis-export-'));
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar', { timeout: 20000 });
  await page.waitForSelector('.sb-more', { timeout: 20000 });
  const first = page.locator('.sb-more').first();
  const label = await first.getAttribute('aria-label');
  await first.click();
  const item = page.getByRole('menuitem', { name: 'Exportar .md' }).first();
  await item.waitFor({ timeout: 10000 });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), item.click()]);
  const target = join(dir, download.suggestedFilename());
  await download.saveAs(target);
  const bytes = statSync(target).size;
  console.log(JSON.stringify({ menu: label, archivo: download.suggestedFilename(), bytes, errors }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ fallo: String(error && error.message), errors }, null, 2));
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
  await browser.close();
}
