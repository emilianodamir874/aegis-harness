// Diagnostico: el cliente pide /tts cuando la lectura esta encendida?
// No toca sesiones: usa la superficie de debug (__aegisWeb.read.pump) y cuenta requests.
import { chromium } from 'playwright';

const url = process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788';
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const tts = [];
const errs = [];
page.on('request', (r) => { if (r.url().includes('/tts?')) tts.push(r.url()); });
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(3000);

const before = await page.evaluate(() => ({ on: window.__aegisWeb.read.on(), cls: document.getElementById('btn-read').className }));
console.log('antes:', JSON.stringify(before));

await page.click('#btn-read');
await page.waitForTimeout(500);
const after = await page.evaluate(() => ({ on: window.__aegisWeb.read.on(), cls: document.getElementById('btn-read').className }));
console.log('despues del toggle:', JSON.stringify(after));

await page.evaluate(() => window.__aegisWeb.read.pump('diag-1', '## \uD83D\uDD0A Para escuchar\n\nHola, esta es una prueba de lectura en voz alta.'));
await page.waitForTimeout(2500);
console.log('requests /tts:', tts.length);
for (const u of tts.slice(0, 3)) console.log('  ' + u.slice(0, 120));

// prueba 2: respuesta SIN bloque "Para escuchar" (lo que pasa en modo debate)
const antes2 = tts.length;
await page.evaluate(() => window.__aegisWeb.read.pump('diag-2', 'Esto es una respuesta normal, sin bloque de lectura, con una oracion completa.'));
await page.waitForTimeout(2000);
console.log('requests /tts sin bloque:', tts.length - antes2);

if (errs.length) console.log('errores de pagina: ' + errs.join(' | '));
await browser.close();
