import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'networkidle', timeout: 30000 });
await p.waitForTimeout(3000);
const dato = await p.evaluate(() => {
  const ids = [...document.querySelectorAll('[id*="model"], [class*="model"]')].map((e) => ({ id: e.id, clase: e.className, texto: (e.textContent || '').trim().slice(0, 80), oculto: e.hidden }));
  const bienvenida = (document.getElementById('welcome') || {}).innerText || '';
  return { ids, bienvenida: bienvenida.replace(/\n+/g, ' | ').slice(0, 300) };
});
console.log(JSON.stringify(dato, null, 1));
await b.close();
