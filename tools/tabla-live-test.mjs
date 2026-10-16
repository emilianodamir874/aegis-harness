import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 25000 });
await p.waitForTimeout(2500);
await p.click('#btn-menu').catch(() => {});
await p.waitForTimeout(700);
await p.click('[data-id="20261015_21"]');
await p.waitForTimeout(12000);
const info = await p.evaluate(() => {
  const t = [...document.querySelectorAll('#messages table')].find((x) => /Medido en 390x844/.test(x.textContent || ''));
  if (!t) return { error: 'no encontre esa tabla' };
  const c1 = t.querySelector('tbody td');
  const c2 = t.querySelectorAll('tbody td')[1];
  const r1 = c1.getBoundingClientRect(), r2 = c2.getBoundingClientRect();
  return { dataCols: t.getAttribute('data-cols'), tdDisplay: getComputedStyle(c1).display, ancho1: Math.round(r1.width), ancho2: Math.round(r2.width), seSale2: Math.round(r2.right) > document.documentElement.clientWidth, texto1: c1.textContent.trim().slice(0, 40), texto2: c2.textContent.trim().slice(0, 40) };
});
// boton de escuchar de un mensaje del asistente
const audio = await p.evaluate(() => { const b = [...document.querySelectorAll('#messages button')].find((x) => /escuchar/i.test(x.textContent || '')); return { hayBoton: !!b, texto: b ? b.textContent.trim().slice(0, 30) : null, titulo: b ? b.title : null }; });
console.log(JSON.stringify({ info, audio }, null, 1));
await b.close();
