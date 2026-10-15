import { chromium } from 'playwright';
const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await br.newContext({ viewport: { width: 430, height: 900 } });
const p = await ctx.newPage();
const errs = [], tts = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)));
p.on('request', (r) => { if (r.url().includes('/tts?')) tts.push(decodeURIComponent(new URL(r.url()).searchParams.get('text') || '')); });
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.read, null, { timeout: 20000 });
console.log('1) apagado');
await p.evaluate(() => window.__aegisWeb.read.toggle(true));
await p.evaluate((t) => window.__aegisWeb.read.pump('k1', t), '## Sin bloque\nNada que leer.');
await p.waitForTimeout(500);
console.log('   pedidos /tts: ' + JSON.stringify(tts));
const partes = [
  '## Para escuchar\nPrimera frase corta.',
  '## Para escuchar\nPrimera frase corta. Segunda frase del bloque.',
  '## Para escuchar\nPrimera frase corta. Segunda frase del bloque.\n\n## Detalle\nEsto no se lee.',
];
for (const t of partes) { await p.evaluate(([k, x]) => window.__aegisWeb.read.pump(k, x), ['k2', t]); await p.waitForTimeout(2500); }
console.log('2) stream en vivo -> pedidos /tts: ' + JSON.stringify(tts));
const st = await p.evaluate(() => ({ on: window.__aegisWeb.read.on(), fallos: window.__aegisWeb.read.state().fallos, clase: document.getElementById('btn-read').className, guardado: localStorage.getItem('aegis.readOn') }));
console.log('3) estado: ' + JSON.stringify(st));
await p.evaluate(() => window.__aegisWeb.read.toggle(false));
console.log('4) apagado -> ' + JSON.stringify({ clase: await p.evaluate(() => document.getElementById('btn-read').className) }));
console.log('errores: ' + JSON.stringify(errs));
await br.close();
