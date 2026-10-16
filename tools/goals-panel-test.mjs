import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 110)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(1800);
const inicial = await p.evaluate(() => ({
  popOculto: document.getElementById('goals').hidden,
  columnas: getComputedStyle(document.querySelector('.app')).gridTemplateColumns,
  posicion: getComputedStyle(document.getElementById('goals')).position,
  marcaBoton: document.getElementById('btn-goals').getAttribute('aria-pressed'),
}));
// Abrir el chat 20261015_21 con un clic REAL en su fila (el manejador cuelga de un hijo).
await p.click('[data-id="20261015_21"]');
await p.waitForFunction(() => window.__aegisWeb.state.current && window.__aegisWeb.state.current.id === '20261015_21', null, { timeout: 20000 });
const title = await p.evaluate(() => document.getElementById('chat-title').textContent);
// Popover con el boton de la barra.
await p.click('#btn-goals');
await p.waitForFunction(() => document.querySelectorAll('#goals .gp-item').length > 0, null, { timeout: 25000 });
const pop = await p.evaluate(() => {
  const items = [...document.querySelectorAll('#goals .gp-item')];
  return {
    visible: !document.getElementById('goals').hidden,
    ancho: Math.round(document.getElementById('goals').getBoundingClientRect().width),
    derecha: Math.round(document.getElementById('goals').getBoundingClientRect().right) <= window.innerWidth,
    titulo: document.querySelector('.gp-title').textContent,
    secciones: [...document.querySelectorAll('#goals .gp-sec')].map((n) => n.textContent),
    items: items.length,
    textos: items.map((n) => n.querySelector('.gp-text').textContent.slice(0, 45)),
    metas: items.map((n) => n.querySelector('.gp-meta').textContent),
    botones: [...document.querySelectorAll('#goals .gp-open')].map((n) => n.textContent),
    soloEsteChat: [...document.querySelectorAll('#goals .gp-item')].length === (window.__aegisWeb.state.goals || []).length,
  };
});
await p.keyboard.press('Escape');
await p.waitForTimeout(500);
const cierre = await p.evaluate(() => ({ oculto: document.getElementById('goals').hidden, columnas: getComputedStyle(document.querySelector('.app')).gridTemplateColumns }));
console.log(JSON.stringify({ inicial, title, pop, cierre, errs }, null, 1));
await b.close();
