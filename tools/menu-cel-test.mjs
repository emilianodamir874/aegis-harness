import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(2000);
await p.click('#btn-menu').catch(() => {});
await p.waitForTimeout(900);
await p.click('[data-id]');
await p.waitForTimeout(4500);
await p.click('#btn-menu').catch(() => {});
await p.waitForTimeout(800);
const abrir = async (n, archivo) => {
  const info = await p.evaluate((n) => {
    const wraps = document.querySelectorAll('#chips .chip-wrap');
    const btn = wraps[n] ? wraps[n].querySelector('button.chip') : null;
    if (!btn) return { error: 'sin chip ' + n + ' de ' + wraps.length };
    btn.click();
    const menu = [...document.querySelectorAll('.menu')].find((m) => !m.hidden);
    const rb = btn.getBoundingClientRect();
    if (!menu) return { chip: btn.textContent, error: 'el menu no quedo visible', menus: [...document.querySelectorAll('.menu')].map((m) => ({ hidden: m.hidden, clase: m.className, padre: m.parentElement.tagName })) };
    const rm = menu.getBoundingClientRect();
    const cs = getComputedStyle(menu);
    return {
      chip: { texto: btn.textContent, x: Math.round(rb.x), w: Math.round(rb.width) },
      menu: { x: Math.round(rm.x), y: Math.round(rm.y), w: Math.round(rm.width), h: Math.round(rm.height), derecha: Math.round(rm.right), abajo: Math.round(rm.bottom) },
      estilos: { position: cs.position, left: cs.left, right: cs.right, top: cs.top, width: cs.width, maxWidth: cs.maxWidth, minWidth: cs.minWidth, overflowX: cs.overflowX, boxSizing: cs.boxSizing, padre: menu.parentElement.tagName },
      anchoVista: document.documentElement.clientWidth, altoVista: window.innerHeight,
      desbordeX: rm.left < 0 ? 'IZQUIERDA ' + Math.round(-rm.left) : (rm.right > document.documentElement.clientWidth ? 'DERECHA ' + Math.round(rm.right - document.documentElement.clientWidth) : 'ok'),
      desbordeY: rm.bottom > window.innerHeight ? 'ABAJO ' + Math.round(rm.bottom - window.innerHeight) : 'ok',
      contenido: { scrollW: menu.scrollWidth, clientW: menu.clientWidth, scrollH: menu.scrollHeight },
      filas: [...menu.children].map((f) => { const r = f.getBoundingClientRect(); return f.textContent.trim().slice(0, 24) + ' [x=' + Math.round(r.x) + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) + ']'; }),
    };
  }, n);
  await p.screenshot({ path: 'C:\\Users\Emiliano\\tmp\\inv\\' + archivo });
  return info;
};
const prov = await abrir(0, 'cel-prov.png');
await p.evaluate(() => document.querySelectorAll('.menu').forEach((m) => (m.hidden = true)));
await p.waitForTimeout(400);
const modo = await abrir(1, 'cel-modo.png');
console.log(JSON.stringify({ prov, modo }, null, 1));
await b.close();
