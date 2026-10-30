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
const info = await p.evaluate(() => {
  const btn = document.querySelectorAll('#chips .chip-wrap')[0].querySelector('button.chip');
  btn.click();
  const menu = [...document.querySelectorAll('.menu')].find((m) => !m.hidden);
  if (!menu) return { error: 'menu no visible' };
  const r = menu.getBoundingClientRect();
  const cs = getComputedStyle(menu);
  const puntos = [[0.2, 0.2], [0.5, 0.5], [0.8, 0.85]].map(([fx, fy]) => {
    const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy);
    const e = document.elementFromPoint(x, y);
    return y + 'px -> ' + (e ? (e.closest('.menu') ? 'MENU ok (' + e.className.split(' ')[0] + ')' : (e.id ? '#' + e.id : '.' + String(e.className).split(' ')[0]) + ' ARRIBA DEL MENU') : 'nada');
  });
  const msgs = document.querySelector('#messages');
  const primerMsg = document.querySelector('#messages .msg, #messages .msg-inner, #messages > div');
  const csM = primerMsg ? getComputedStyle(primerMsg) : null;
  return {
    menu: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    estilos: { opacity: cs.opacity, animation: cs.animationName, transform: cs.transform, zIndex: cs.zIndex, background: cs.backgroundColor },
    puntos,
    mensajes: { hay: !!(msgs && msgs.children.length), hijos: msgs ? msgs.children.length : 0, muestra: csM ? { z: csM.zIndex, transform: csM.transform, opacity: csM.opacity, background: csM.backgroundColor } : null },
    desbordeX: r.left < 0 ? 'IZQUIERDA' : (r.right > document.documentElement.clientWidth ? 'DERECHA' : 'ok'),
  };
});
await p.screenshot({ path: 'C:/Users/Emiliano/tmp/inv/cel-final.png' });
console.log(JSON.stringify(info, null, 1));
await b.close();
