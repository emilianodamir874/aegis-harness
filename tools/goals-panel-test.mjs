import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 110)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(1500);
const inicial = await p.evaluate(() => ({
  popOculto: document.getElementById('goals').hidden,
  columnas: getComputedStyle(document.querySelector('.app')).gridTemplateColumns,
  anchoPanel: Math.round(document.getElementById('goals').getBoundingClientRect().width),
}));
// Abrir un chat conocido que tiene /goal (20261015_21) desde la lista izquierda.
const abierto = await p.evaluate(() => {
  const s = (window.__aegisWeb.state.sessions || []).find((x) => (x.id || x.sessionId) === '20261015_21');
  const fila = document.querySelector('[data-id="20261015_21"]');
  if (fila) { fila.click(); return 'fila'; }
  return s ? 'encontrada sin fila' : 'no esta en la lista';
});
await p.waitForTimeout(4000);
const titulo = await p.evaluate(() => document.getElementById('chat-title').textContent);
// Popover: abrir con el boton.
await p.click('#btn-goals');
await p.waitForSelector('#goals:not([hidden])', { timeout: 15000 });
await p.waitForFunction(() => document.querySelectorAll('#goals .gp-item').length > 0, null, { timeout: 25000 });
const pop = await p.evaluate(() => {
  const items = [...document.querySelectorAll('#goals .gp-item')];
  return {
    visible: !document.getElementById('goals').hidden,
    posicion: getComputedStyle(document.getElementById('goals')).position,
    ancho: Math.round(document.getElementById('goals').getBoundingClientRect().width),
    titulo: document.querySelector('.gp-title').textContent,
    secciones: [...document.querySelectorAll('#goals .gp-sec')].map((n) => n.textContent),
    items: items.length,
    textos: items.map((n) => n.querySelector('.gp-text').textContent.slice(0, 40)),
    metillas: items.map((n) => n.querySelector('.gp-meta').textContent),
    botones: [...document.querySelectorAll('#goals .gp-open')].map((n) => n.textContent),
  };
});
// Escape lo cierra.
await p.keyboard.press('Escape');
await p.waitForTimeout(400);
const cerrado = await p.evaluate(() => document.getElementById('goals').hidden);
const gridFinal = await p.evaluate(() => getComputedStyle(document.querySelector('.app')).gridTemplateColumns);
console.log(JSON.stringify({ inicial, abierto, titulo, pop, cerradoConEscape: cerrado, gridFinal, errs }, null, 1));
await b.close();
