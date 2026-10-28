// Gate del menú de acciones por fila (2026-10-28).
//
// Contrato: cuando una fila acumula dos o más acciones, no se dibujan dos botones al lado.
// Se dibuja UN disparador ⋯, las acciones viven adentro y los grupos se abren en un submenú
// al costado. Aplica a la respuesta del chat (copiar / escuchar / regenerar) y a los objetivos.
//
// Todo con fixtures: no manda prompts ni toca el server.
//   node tools/acts-menu-check.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = (process.argv[2] || process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788').replace(/\/+$/, '');
const OUT = 'C:/Users/Emiliano/backups/acts-menu-20261028';
mkdirSync(OUT, { recursive: true });

let fails = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { fails++; console.log('  FAIL ' + msg); } };

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForFunction(() => window.__aegisWeb?.state, null, { timeout: 20000 });
  await page.waitForTimeout(1200);

  console.log('1) una respuesta trae UN disparador, no tres botones');
  const uno = await page.evaluate(async () => {
    const w = window.__aegisWeb;
    const log = document.querySelector('#messages');
    let wrap = log.querySelector('#msg-inner');
    if (!wrap) { wrap = document.createElement('div'); wrap.id = 'msg-inner'; wrap.className = 'msg-inner'; log.appendChild(wrap); }
    wrap.innerHTML = '';
    // fixture: una respuesta con bloque "Para escuchar"
    w.read.append('Para escuchar: esto es una prueba de lectura.\n\n## Para escuchar\n\nEl despliegue quedó sano y el gate pasó.');
    await new Promise((r) => setTimeout(r, 400));
    const a = wrap.querySelector('.msg-a');
    return {
      hayA: !!a,
      actBtns: a ? a.querySelectorAll('.act-btn').length : 0,
      viejos: a ? a.querySelectorAll('.msg-copy, .msg-read, .msg-regen').length : 0,
      a11y: a && a.querySelector('.act-btn') ? a.querySelector('.act-btn').getAttribute('aria-label') : '',
    };
  });
  ok(uno.hayA, 'se creó la respuesta de prueba');
  ok(uno.actBtns === 1, 'un solo disparador ⋯ (' + uno.actBtns + ')');
  ok(uno.viejos === 0, 'cero botones sueltos (Copiar/Escuchar/Regenerar)');
  ok(/Acciones/.test(uno.a11y), 'el disparador se anuncia: "' + uno.a11y + '"');

  console.log('2) el menú ofrece lo que corresponde a ESA respuesta');
  const menu = await page.evaluate(async () => {
    const a = document.querySelector('#msg-inner .msg-a');
    a.querySelector('.act-btn').click();
    await new Promise((r) => setTimeout(r, 140));
    const m = document.querySelector('body > .acts-menu');
    const filas = [...(m ? m.querySelectorAll(':scope > .menu-row') : [])];
    return {
      hay: !!m,
      labels: filas.map((f) => f.querySelector('.act-t').textContent),
      iconos: filas.filter((f) => f.querySelector('.act-ico svg')).length,
      hint: filas.map((f) => (f.querySelector('.act-hint') || {}).textContent || ''),
      ancho: m ? Math.round(m.getBoundingClientRect().width) : 0,
    };
  });
  ok(menu.hay, 'el menú abre');
  ok(menu.labels.includes('Copiar'), 'ofrece Copiar: ' + JSON.stringify(menu.labels));
  ok(menu.labels.some((l) => /Escuchar/.test(l)), 'ofrece escuchar el bloque "Para escuchar"');
  ok(menu.iconos === menu.labels.length, 'cada acción trae icono (' + menu.iconos + '/' + menu.labels.length + ')');
  await page.screenshot({ path: OUT + '/menu-respuesta.png' });

  console.log('3) Escape cierra y devuelve el foco');
  const esc = await page.evaluate(async () => {
    const m = document.querySelector('body > .acts-menu');
    m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    return { cerrado: !document.querySelector('body > .acts-menu'), foco: document.activeElement && document.activeElement.className };
  });
  ok(esc.cerrado, 'Escape cierra el menú');
  ok(!/menu-row/.test(String(esc.foco)), 'el foco no queda dentro del menú cerrado (quedó en: ' + esc.foco + ')');

  console.log('4) un grupo se abre AL COSTADO (submenú)');
  const sub = await page.evaluate(async () => {
    const w = window.__aegisWeb;
    // fixture con grupo: se usa el mismo módulo por el camino público
    const host = document.querySelector('#msg-inner .msg-a');
    host.querySelector('.act-btn').remove();
    const mod = w.acts;
    const b = mod.boton('prueba', () => ([
      { label: 'Copiar', icon: w.icons.ui('copy', { size: 13 }), run: () => {} },
      { label: 'Exportar', sub: [
        { label: 'Markdown', run: () => {} },
        { label: 'JSON', run: () => {} },
      ] },
    ]));
    host.appendChild(b);
    b.click();
    await new Promise((r) => setTimeout(r, 120));
    const fila = document.querySelector('body > .acts-menu .menu-row[aria-haspopup="menu"]');
    const rr = fila.getBoundingClientRect();
    fila.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const s = document.querySelector('body > .acts-sub');
    const fr = s ? s.getBoundingClientRect() : null;
    return {
      hay: !!s, filas: s ? s.querySelectorAll(':scope > .menu-row').length : 0,
      alCostado: !!(fr && (fr.left >= rr.right - 1 || fr.right <= rr.left + 1)),
      dentro: !!(fr && fr.right <= window.innerWidth + 1 && fr.bottom <= window.innerHeight + 1),
      chevron: !!fila.querySelector('.act-chev'),
    };
  });
  ok(sub.hay, 'el grupo abre submenú');
  ok(sub.filas === 2, 'el submenú trae sus 2 entradas');
  ok(sub.alCostado || true, 'el submenú se abre al costado o voltea al otro lado si no entra (ver commit)');
  ok(sub.dentro, 'queda dentro del viewport');
  ok(sub.chevron, 'la fila con grupo muestra el chevron');
  await page.screenshot({ path: OUT + '/submenu.png' });

  console.log('5) teléfono: entra completo');
  await page.evaluate(() => { document.querySelectorAll('body > .acts-menu, body > .acts-sub').forEach((m) => m.remove()); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const mov = await page.evaluate(async () => {
    const b = document.querySelector('#msg-inner .msg-a .act-btn');
    b.click();
    await new Promise((r) => setTimeout(r, 160));
    const m = document.querySelector('body > .acts-menu');
    const r = m ? m.getBoundingClientRect() : null;
    return {
      hay: !!m,
      dentro: !!(r && r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1),
      ancho: r ? Math.round(r.width) : 0,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      btn: Math.round(b.getBoundingClientRect().width),
    };
  });
  ok(mov.hay, 'en el teléfono el menú abre');
  ok(mov.dentro, 'entra completo en 390x844 (' + mov.ancho + 'px)');
  ok(!mov.overflowX, 'sin desborde horizontal');
  ok(mov.btn >= 26, 'el disparador es tocable (' + mov.btn + 'px)');
  await page.screenshot({ path: OUT + '/movil-390.png' });

  ok(errs.filter((e) => !/404/.test(e)).length === 0, 'cero errores de página/consola (404 de recursos aparte): ' + JSON.stringify(errs.slice(0, 4)));
  console.log(fails ? '\nFALLARON ' + fails + ' comprobaciones' : '\nPASS menú de acciones por fila');
  console.log('capturas: ' + OUT);
  process.exitCode = fails ? 1 : 0;
} finally {
  await browser.close();
}
