import { chromium } from 'playwright';
import fs from 'node:fs';
const dir = 'C:/Users/Emiliano/tmp/ui-audit';
fs.mkdirSync(dir, { recursive: true });
const b = await chromium.launch();
const out = { viewports: {}, errores: [] };

const medir = () => {
  const vis = (n) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const todosCli = [...document.querySelectorAll('button, a, input, textarea, [role="button"], [tabindex]')].filter(vis);
  // Los controles que estan DENTRO de los mensajes (botones de las herramientas, "Ver todo",
  // bloques de razonamiento) son contenido, no interfaz: contarlos mezclaba las mediciones.
  const clicables = todosCli.filter((n) => !n.closest('#messages'));
  const controlesEnMensajes = todosCli.length - clicables.length;
  const chicos = clicables.filter((n) => { const r = n.getBoundingClientRect(); return r.width < 40 || r.height < 40; })
    .map((n) => ({ sel: n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : ''), w: Math.round(n.getBoundingClientRect().width), h: Math.round(n.getBoundingClientRect().height), txt: (n.getAttribute('aria-label') || n.textContent || '').trim().slice(0, 24) }));
  const textos = [...document.querySelectorAll('p, span, div, button, li, small, label, h1, h2, h3')].filter((n) => vis(n) && n.children.length === 0 && (n.textContent || '').trim());
  const lum = (c) => { const [r, g, bl] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const fondo = (n) => { let e = n; while (e && e !== document.documentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.9) return c.rgb; e = e.parentElement; } return [12, 12, 14]; };
  const contraste = [];
  const chicosTexto = [];
  for (const n of textos) {
    const s = getComputedStyle(n);
    const px = parseFloat(s.fontSize);
    if (px < 12) chicosTexto.push({ sel: n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : ''), px, txt: n.textContent.trim().slice(0, 26) });
    const c = parse(s.color); if (!c) continue;
    const l1 = lum(c.rgb), l2 = lum(fondo(n));
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const grande = px >= 24 || (px >= 18.66 && parseInt(s.fontWeight) >= 700);
    if (ratio < (grande ? 3 : 4.5)) contraste.push({ sel: n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : ''), ratio: Math.round(ratio * 100) / 100, px: Math.round(px), txt: n.textContent.trim().slice(0, 26) });
  }
  const sinLabel = clicables.filter((n) => !(n.getAttribute('aria-label') || n.getAttribute('title') || (n.textContent || '').trim() || n.getAttribute('placeholder')))
    .map((n) => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : ''));
  return {
    clicables: clicables.length,
    controlesEnMensajes,
    chicosTotal: chicos.length, chicos: chicos.slice(0, 8),
    chicosTexto: chicosTexto.slice(0, 6),
    contrasteTotal: contraste.length, contraste: contraste.slice(0, 8),
    sinLabel,
    scrollPagina: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth },
    fuentes: [...new Set(textos.map((n) => getComputedStyle(n).fontSize))].sort((x, y) => parseFloat(x) - parseFloat(y)),
    cuerpo: { anchoSidebar: Math.round((document.getElementById('sidebar') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width), altoComposer: Math.round((document.querySelector('.composer') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height) },
  };
};

for (const [nombre, vp] of Object.entries({ desktop: { width: 1440, height: 900 }, tablet: { width: 1024, height: 768 }, celular: { width: 430, height: 900 }, chico: { width: 360, height: 780 } })) {
  let ctx;
  try {
    ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => out.errores.push(nombre + ': ' + String(e.message).slice(0, 90)));
    await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 25000 });
    await p.waitForTimeout(2500);
    await p.screenshot({ path: dir + '/' + nombre + '-1-bienvenida.png' });
    out.viewports[nombre + '|bienvenida'] = await p.evaluate(medir);
    // abrir la lista si esta en cajon (movil) y despues una conversacion
    const menu = await p.$('#btn-menu');
    if (menu && await p.evaluate(() => { const s = document.getElementById('sidebar'); return s ? getComputedStyle(s).transform !== 'none' || s.getBoundingClientRect().left < 0 : false; })) {
      await menu.click().catch(() => {});
      await p.waitForTimeout(700);
      await p.screenshot({ path: dir + '/' + nombre + '-2-menu.png' });
    }
    const fila = await p.$('[data-id]');
    if (fila) {
      await fila.click({ timeout: 8000 }).catch(() => {});
      await p.waitForTimeout(4500);
      await p.screenshot({ path: dir + '/' + nombre + '-3-chat.png' });
      out.viewports[nombre + '|chat'] = await p.evaluate(medir);
    }
    const btn = await p.$('#btn-goals');
    if (btn) { await btn.click({ timeout: 5000 }).catch(() => {}); await p.waitForTimeout(1200); await p.screenshot({ path: dir + '/' + nombre + '-4-objetivos.png' }); }
  } catch (e) {
    out.errores.push(nombre + ' (bucle): ' + String(e.message).slice(0, 110));
  } finally { if (ctx) await ctx.close().catch(() => {}); }
}
fs.writeFileSync(dir + '/mediciones.json', JSON.stringify(out, null, 1));
console.log('listo | viewports: ' + Object.keys(out.viewports).length + ' | errores: ' + out.errores.length);
await b.close();
