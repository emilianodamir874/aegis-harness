import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
const errores = [];
p.on('pageerror', (e) => errores.push(String(e.message).slice(0, 120)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.goalFromText, null, { timeout: 20000 });
const casos = await p.evaluate(() => {
  const f = window.__aegisWeb.goalFromText;
  const j = (x) => JSON.stringify(x);
  return {
    set: j(f('/goal vamos con todo')),
    mayus: j(f('/GOAL VAMOS CON TODO!!')),
    largo: j(f('/goal linea uno\nlinea dos')),
    grind: j(f('/grind insistir')),
    off: j(f('/goal off')),
    clear: j(f('/goal clear')),
    soloGoal: j(f('/goal')),
    normal: j(f('hola, /goal en medio')),
    vacio: j(f(''))
  };
});
const dom = await p.evaluate(() => {
  const w = window.__aegisWeb;
  const bar = document.getElementById('goalbar');
  const antes = bar ? bar.hidden : null;
  w.state.goal = 'ordenar la biblioteca y verificar todo'; w.state.grind = null; w.renderGoalBar();
  const r1 = { visible: !bar.hidden, tag: (bar.querySelector('.goalbar-tag') || {}).textContent, texto: (bar.querySelector('.goalbar-text') || {}).textContent, boton: !!document.getElementById('goalbar-x') };
  w.state.grind = w.state.goal; w.renderGoalBar();
  const r2 = { tag: (bar.querySelector('.goalbar-tag') || {}).textContent };
  w.state.goal = null; w.state.grind = null; w.renderGoalBar();
  const r3 = { oculto: bar.hidden, vacio: bar.innerHTML === '' };
  return { ocultoAntes: antes, conGoal: r1, conGrind: r2, trasLimpiar: r3 };
});
console.log(JSON.stringify({ casos, dom, erroresPagina: errores }, null, 1));
await b.close();
