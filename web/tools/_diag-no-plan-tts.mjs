// El plan no se narra: con lectura encendida, un mensaje normal pide /tts y uno con el marcador
// "plan final" no pide nada (y corta el audio en curso).
import { chromium } from 'playwright';

const url = process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788';
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const tts = [];
page.on('request', (r) => { if (r.url().includes('/tts?')) tts.push(r.url()); });
await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(3000);

await page.click('#btn-read');
await page.waitForTimeout(500);
const on = await page.evaluate(() => window.__aegisWeb.read.on());
console.log('lectura: ' + on);

// 1) mensaje normal (con bloque) -> tiene que pedir /tts
const antes = tts.length;
await page.evaluate(() => window.__aegisWeb.read.pump('p1', '## Para escuchar\n\nEsto es una prueba normal de lectura.'));
await page.waitForTimeout(2000);
const normal = tts.length - antes;
console.log('requests con texto normal: ' + normal);

// 2) texto con el marcador de plan -> cero requests
const antes2 = tts.length;
await page.evaluate(() => window.__aegisWeb.read.pump('p2', 'Cierro el debate.\n— plan final —\n1. Medir el tts. 2. Elegir la voz.'));
await page.waitForTimeout(2000);
const conPlan = tts.length - antes2;
console.log('requests con plan final: ' + conPlan);

if (!on) { console.error('FALLA lectura no encendio'); process.exit(1); }
if (normal < 1) { console.error('FALLA texto normal no pidio tts'); process.exit(1); }
if (conPlan !== 0) { console.error('FALLA el plan se leyo (' + conPlan + ' requests)'); process.exit(1); }
console.log('PASS el plan no se lee');
await browser.close();
