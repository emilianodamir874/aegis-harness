import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 110)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(1800);
await p.click('[data-id="20261015_21"]');
await p.waitForFunction(() => window.__aegisWeb.state.current && window.__aegisWeb.state.current.id === '20261015_21', null, { timeout: 20000 });
await p.click('#btn-goals');
await p.waitForFunction(() => document.querySelectorAll('#goals .gp-item').length > 0, null, { timeout: 25000 });
const antes = await p.evaluate(() => document.querySelectorAll('#goals .gp-item').length);
// borrar el primero del panel
await p.click('#goals .gp-item .gp-del');
await p.waitForTimeout(600);
const trasBorrar = await p.evaluate(() => ({
  items: document.querySelectorAll('#goals .gp-item').length,
  pie: (document.querySelector('.gp-pie .gp-restaurar') || {}).textContent || '',
  guardado: (JSON.parse(localStorage.getItem('aegis.goalsOcultos') || '[]')).length,
}));
// restaurar (el popover debe seguir abierto)
const sigueAbierto = await p.evaluate(() => !document.getElementById('goals').hidden);
await p.click('.gp-restaurar');
await p.waitForTimeout(600);
const trasRestaurar = await p.evaluate(() => ({
  items: document.querySelectorAll('#goals .gp-item').length,
  pie: !!document.querySelector('.gp-pie'),
  guardado: (JSON.parse(localStorage.getItem('aegis.goalsOcultos') || '[]')).length,
}));
// objetivo activo (simulado): resaltado + boton Quitar, sin mandar nada
const activo = await p.evaluate(() => {
  const w = window.__aegisWeb;
  const copia = (w.state.goals || []).slice();
  w.state.goals = [{ texto: 'objetivo de prueba', tipo: 'goal', activo: true, cuando: '2026-10-16 00:00:00' }];
  w.renderGoals();
  const it = document.querySelector('#goals .gp-item');
  const r = { clase: it.className, texto: it.querySelector('.gp-text').textContent, botones: [...it.querySelectorAll('button')].map((b) => b.textContent), tituloQuitar: (it.querySelector('.gp-open') || {}).title, tituloBorrar: (it.querySelector('.gp-del') || {}).title };
  w.state.goals = copia; w.renderGoals();
  return r;
});
console.log(JSON.stringify({ antes, trasBorrar, sigueAbierto, trasRestaurar, activo, errs }, null, 1));
await b.close();
