import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(2000);
await p.click('#btn-menu').catch(() => {});
await p.waitForTimeout(800);
await p.click('[data-id]').catch(() => {});
await p.waitForTimeout(5000);
await p.click('#btn-menu').catch(() => {});
await p.waitForTimeout(900);
const capas = await p.evaluate(() => {
  const medir = (etiqueta) => {
    const sb = document.querySelector('.sidebar');
    const app = document.querySelector('.app');
    const cs = sb ? getComputedStyle(sb) : null;
    return etiqueta + ': sidebar z=' + (cs ? cs.zIndex : '?') + ' clase=' + (sb ? sb.className : '?') + ' | app z=' + (app ? getComputedStyle(app).zIndex : '?');
  };
  const cerrado = medir('cerrado');
  const btn = document.getElementById('btn-menu');
  btn.click();
  const abierto = medir('abierto');
  btn.click();
  return { cerrado, abierto };
});
await p.waitForTimeout(800);
const real = await p.evaluate(() => {
  const wrap = document.querySelectorAll('#chips .chip-wrap')[1];
  wrap.querySelector('button.chip').click();
  const menu = [...document.querySelectorAll('.menu')].find((m) => !m.hidden);
  const r = menu.getBoundingClientRect();
  const e = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
  return { menu: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, arriba: e ? (e.closest('.menu') ? 'MENU ok' : 'OTRO: ' + (e.id || e.className)) : 'nada', desbordeX: r.left < 0 ? 'IZQUIERDA' : (r.right > document.documentElement.clientWidth ? 'DERECHA' : 'ok'), filas: [...menu.children].map((f) => f.textContent.trim()) };
});
await p.screenshot({ path: 'C:/Users/Emiliano/tmp/inv/cel-real.png' });
console.log(JSON.stringify({ capas, real }, null, 1));
await b.close();
