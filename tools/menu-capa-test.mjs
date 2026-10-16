import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(2000);
await p.click('#btn-menu').catch(() => {});
await p.waitForTimeout(800);
await p.click('[data-id]');
await p.waitForTimeout(4500);
await p.click('#btn-menu').catch(() => {});   // cerrar el cajon: el chat a la vista
await p.waitForTimeout(900);
const info = await p.evaluate(() => {
  const btn = document.querySelectorAll('#chips .chip-wrap')[0].querySelector('button.chip');
  btn.click();
  const menu = [...document.querySelectorAll('.menu')].find((m) => !m.hidden);
  if (!menu) return { error: 'menu no visible' };
  const r = menu.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(cx, cy);
  const capas = {};
  for (const sel of ['.menu', '.sidebar', 'main', '#messages', '.composer', '#topbar', '.app', 'body']) {
    const el = sel === '.menu' ? menu : document.querySelector(sel);
    if (!el) { capas[sel] = 'no existe'; continue; }
    const cs = getComputedStyle(el);
    capas[sel] = 'z=' + cs.zIndex + ' pos=' + cs.position + ' transform=' + (cs.transform === 'none' ? 'no' : 'SI') + ' filter=' + (cs.filter === 'none' ? 'no' : 'SI') + ' opacity=' + cs.opacity;
  }
  // cadena de ancestros del que quedo arriba
  const cadena = [];
  let e = top;
  while (e && cadena.length < 8) { const cs = getComputedStyle(e); cadena.push((e.id ? '#' + e.id : e.className ? '.' + String(e.className).split(' ')[0] : e.tagName) + ' z=' + cs.zIndex + ' pos=' + cs.position); e = e.parentElement; }
  const menuMenor = menu.getBoundingClientRect();
  return {
    menu: { x: Math.round(menuMenor.x), y: Math.round(menuMenor.y), w: Math.round(menuMenor.width), h: Math.round(menuMenor.height) },
    puntoMedido: { x: cx, y: cy },
    arribaDeTodo: top ? (top.id ? '#' + top.id : top.className ? '.' + String(top.className).split(' ')[0] : top.tagName) : 'nada',
    esElMenuOsuHijo: !!(top && (top === menu || menu.contains(top))),
    cadena,
    capas,
  };
});
await p.screenshot({ path: 'C:/Users/Emiliano/tmp/inv/cel-capa.png' });
console.log(JSON.stringify(info, null, 1));
await b.close();
