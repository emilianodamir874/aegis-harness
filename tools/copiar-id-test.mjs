import { chromium } from 'playwright';
const br = await chromium.launch();
const ctx = await br.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.copyId, null, { timeout: 20000 });
await p.waitForTimeout(2500);

const idFila = await p.evaluate(() => { const r = document.querySelector('.sb-row'); return r ? r.dataset.id : null; });
console.log('ID de la primera sesion: ' + idFila);
if (!idFila) { console.log('sin sesiones: no se puede probar'); await br.close(); process.exit(0); }

// abrir el menu ⋮ de la primera fila (el boton esta oculto hasta hover: click por codigo)
await p.evaluate(() => document.querySelector('.sb-row .sb-more').click());
await p.waitForTimeout(400);
const items = await p.evaluate(() => {
  const bs = [...document.querySelectorAll('button')].filter((b) => /Copiar ID|Renombrar|Exportar|Archivar|Desarchivar/.test(b.textContent));
  return bs.map((b) => b.textContent.trim());
});
console.log('opciones del menu: ' + JSON.stringify(items));
console.log('tiene Copiar ID: ' + items.some((t) => /Copiar ID/i.test(t)));

const clickeado = await p.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /Copiar ID de sesión/i.test(x.textContent));
  if (!b) return false;
  b.click(); return true;
});
await p.waitForTimeout(800);
const clip = await p.evaluate(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return 'error: ' + e.message; } });
const notas = await p.evaluate(() => [...document.querySelectorAll('.sysnote')].map((e) => e.textContent).slice(-1));
console.log('opcion clickeada: ' + clickeado);
console.log('portapapeles: ' + JSON.stringify(clip));
console.log('nota: ' + JSON.stringify(notas));
console.log('== COINCIDE: ' + (clip === idFila));
console.log('errores: ' + JSON.stringify(errs));
await br.close();
