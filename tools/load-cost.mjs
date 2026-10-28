// Mide lo que un navegador real trae para levantar la app: cantidad de requests, bytes
// transferidos y tiempo hasta transcript listo. Es la métrica del túnel, medida en loopback
// (sin el RTT de Cloudflare): lo que se compara es cantidad de viajes y bytes, no latencia.
//   node tools/load-cost.mjs [url]
import { chromium } from 'playwright';

const url = (process.argv[2] || 'http://127.0.0.1:3788').replace(/\/+$/, '');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const porTipo = new Map();
let total = 0;
let encodes = new Set();
page.on('response', async (r) => {
  const req = r.request();
  const tipo = req.resourceType();
  const len = Number(r.headers()['content-length'] || 0);
  const enc = r.headers()['content-encoding'] || 'identity';
  if (req.url().startsWith(url)) { total++; encodes.add(enc); }
  const prev = porTipo.get(tipo) || { n: 0, bytes: 0 };
  porTipo.set(tipo, { n: prev.n + 1, bytes: prev.bytes + len });
});

const t0 = Date.now();
await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => window.__aegisWeb?.state?.current !== undefined, null, { timeout: 20000 });
const listo = Date.now() - t0;
await page.waitForTimeout(600);

const filas = [...porTipo.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
console.log('url: ' + url);
console.log('requests al origen: ' + total + ' · codificaciones: ' + [...encodes].join(','));
console.log('transcript listo: ' + listo + ' ms (loopback)');
console.log('\ntipo        n    bytes transferidos');
for (const [t, v] of filas) console.log(t.padEnd(11) + String(v.n).padStart(3) + String(v.bytes).padStart(10));
const suma = filas.reduce((a, [, v]) => a + v.bytes, 0);
console.log('\ntotal transferido: ' + suma + ' B (' + (suma / 1024).toFixed(1) + ' KB)');
await browser.close();
