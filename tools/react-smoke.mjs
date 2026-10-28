// Smoke del cliente React contra una instancia de aegis-web (por defecto 3790, la de prueba).
// Sólo LEE: initialize, session/list y session/load. No manda prompts ni responde permisos.
//
//   node tools/react-smoke.mjs http://127.0.0.1:3790/app-react/
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const url = process.argv[2] || 'http://127.0.0.1:3790/app-react/';
const outDir = 'tools/shots';
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
const logs = [];
page.on('console', (message) => {
  logs.push(`${message.type()}: ${message.text()}`);
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

const started = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForSelector('.sidebar', { timeout: 15_000 });

const metrics = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = performance.getEntriesByType('paint').find((entry) => entry.name === 'first-contentful-paint');
  return {
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load: nav ? Math.round(nav.loadEventEnd) : null,
    fcp: paint ? Math.round(paint.startTime) : null,
    nodes: document.querySelectorAll('*').length,
    stylesheets: document.styleSheets.length,
    hasTokens: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  };
});

// Espera a que el store abra el chat más reciente (o muestre la bienvenida).
let session = null;
try {
  await page.waitForSelector('.sb-item', { timeout: 10_000 });
  session = await page.locator('.sb-item').first().innerText();
  await page.locator('.sb-item').first().click();
  await page.waitForSelector('.msg, .welcome', { timeout: 15_000 });
} catch {
  // Instalación sin sesiones: la bienvenida es un resultado válido.
}

const info = await page.evaluate(() => ({
  title: document.querySelector('.topbar-title h1')?.textContent ?? '',
  messages: document.querySelectorAll('.msg').length,
  composer: Boolean(document.querySelector('#input')),
  connection: document.querySelector('#conn-text')?.textContent ?? '',
  login: Boolean(document.querySelector('#login')),
}));

await page.screenshot({ path: `${outDir}/react-smoke.png`, fullPage: false });
await browser.close();

const result = {
  url,
  elapsedMs: Date.now() - started,
  metrics,
  firstSession: session ? session.split('\n')[0] : null,
  info,
  errors,
  logs: logs.slice(-10),
};
console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) process.exitCode = 1;
