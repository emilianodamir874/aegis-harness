import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 100)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.fetchGoals, null, { timeout: 20000 });
// El panel se abre solo en pantallas anchas; si estuviera cerrado, se abre con el boton.
if (await p.evaluate(() => document.getElementById('goals').hidden)) await p.click('#btn-goals');
await p.waitForSelector('.gp-item', { timeout: 25000 });
const info = await p.evaluate(() => {
  const panel = document.getElementById('goals');
  const items = [...document.querySelectorAll('.gp-item')];
  return {
    visible: !panel.hidden && panel.getBoundingClientRect().width > 100,
    ancho: Math.round(panel.getBoundingClientRect().width),
    columnas: getComputedStyle(document.querySelector('.app')).gridTemplateColumns,
    secciones: [...document.querySelectorAll('.gp-sec')].map((n) => n.textContent),
    items: items.length,
    primero: { estado: items[0].className, texto: items[0].querySelector('.gp-text').textContent.slice(0, 50), meta: items[0].querySelector('.gp-meta').textContent, boton: items[0].querySelector('.gp-open').textContent },
    botones: document.querySelectorAll('.gp-open').length,
  };
});
// Reanudar: abre la conversacion del objetivo (titulo del chat distinto de "Nuevo chat").
const antes = await p.evaluate(() => document.getElementById('chat-title').textContent);
await p.click('.gp-item .gp-open');
await p.waitForTimeout(3500);
const despues = await p.evaluate(() => document.getElementById('chat-title').textContent);
console.log(JSON.stringify({ info, tituloAntes: antes, tituloDespues: despues, cambio: antes !== despues, errs }, null, 1));
await b.close();
