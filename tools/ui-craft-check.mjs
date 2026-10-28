// Gate de la capa visual nueva (2026-10-28): iconos por herramienta, fases en vivo,
// banda de lo que el modelo no ve, densidad y modo presentación.
//
// Todo contra la web viva (AEGIS_WEB_URL, default 127.0.0.1:3788) y sin turnos reales:
// las piezas se ejercitan con los hooks de `window.__aegisWeb` y con fixtures inyectadas
// en #msg-inner. Un fixture que no se creó hace fallar el assert (nunca se prueba el
// fallback de un selector vacío).
//
//   node tools/ui-craft-check.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = (process.argv[2] || process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788').replace(/\/+$/, '');
const OUT = 'C:/Users/Emiliano/backups/ui-craft-20261028';
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
  await page.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
  await page.waitForTimeout(1500);

  // ---------- 1. iconos ----------
  console.log('1) iconos por herramienta y estado');
  const set = await page.evaluate(() => {
    const w = window.__aegisWeb;
    const wrap = document.querySelector('#msg-inner') || (() => {
      const m = document.querySelector('#messages');
      const d = document.createElement('div'); d.id = 'msg-inner'; d.className = 'msg-inner'; m.appendChild(d); return d;
    })();
    const kinds = ['shell', 'read', 'edit', 'search', 'glob', 'browser', 'mcp', 'db', 'doc', 'git', 'memory', 'plan', 'voice', 'lock', 'compact'];
    for (const k of kinds) {
      const el = document.createElement('div');
      el.className = 'tool';
      el.dataset.kind = k;
      el.dataset.state = 'ok';
      el.innerHTML = '<span class="tool-ic">' + w.icons.tool(k, 'ok') + '</span><div class="tool-body"><div class="tool-title">' + k + '</div></div>';
      wrap.appendChild(el);
    }
    const run = document.createElement('div');
    run.className = 'tool'; run.dataset.kind = 'shell'; run.dataset.state = 'run';
    run.innerHTML = '<span class="tool-ic">' + w.icons.tool('shell', 'run') + '</span><div class="tool-body"><div class="tool-title">corriendo</div></div>';
    wrap.appendChild(run);
    const ic = wrap.querySelectorAll('.tool .tool-ic svg');
    return { n: ic.length, icons: [...new Set([...ic].map((s) => [...s.classList].find((c) => c.startsWith('tico-'))))] };
  });
  ok(set.n >= 15, 'se pintaron ' + set.n + ' iconos de herramienta');
  ok(set.icons.length >= 10, 'hay ' + set.icons.length + ' iconos distintos (no un fallback unico): ' + set.icons.join(' '));

  // ---------- 2. fases en vivo ----------
  console.log('2) fases del turno en la barra');
  const phase = await page.evaluate(async () => {
    const w = window.__aegisWeb;
    document.querySelector('#runbar').hidden = false;
    w.view.setPhase('tool', 'corriendo tests');
    const a = document.querySelector('#runbar-phase');
    const r1 = { hidden: a.hidden, text: a.textContent.trim(), cls: document.querySelector('.runbar-phase .ui-ico') ? 1 : 0, phase: document.querySelector('#runbar').dataset.phase };
    w.view.setPhase('permission', 'shell');
    const r2 = { phase: document.querySelector('#runbar').dataset.phase, warn: getComputedStyle(a).borderColor };
    w.view.setPhase('');
    const r3 = { hidden: a.hidden, phase: document.querySelector('#runbar').dataset.phase };
    return { r1, r2, r3 };
  });
  ok(!phase.r1.hidden && /Herramienta/.test(phase.r1.text), 'fase herramienta visible: "' + phase.r1.text + '"');
  ok(phase.r1.cls === 1, 'la fase trae icono propio');
  ok(phase.r2.phase === 'permission', 'la fase de permiso cambia el estado de la barra');
  ok(phase.r3.hidden === true, 'terminar el turno limpia la fase');

  // ---------- 3. banda de lo oculto: nunca se pierde del usuario ----------
  console.log('3) lo oculto al modelo sigue a la vista');
  const band = await page.evaluate(async () => {
    const w = window.__aegisWeb;
    const wrap = document.querySelector('#msg-inner');
    wrap.innerHTML = '';
    const u = document.createElement('div'); u.className = 'msg-user'; u.textContent = 'mensaje viejo del usuario';
    const a = document.createElement('div'); a.className = 'msg-a hidden-from-agent';
    a.innerHTML = '<div class="content">respuesta vieja de la IA (rebobinada)</div>';
    const vis = document.createElement('div'); vis.className = 'msg-a';
    vis.innerHTML = '<div class="content">respuesta viva</div>';
    wrap.append(u, a, vis);
    w.markHiddenTail();
    const b = document.querySelector('#msg-inner .rw-band');
    const head = b && b.querySelector('.rw-band-head');
    const body = b && b.querySelector('.rw-band-body');
    const rows = body ? body.children.length : 0;
    const texto = (body && body.textContent || '').slice(0, 80);
    const colapsadoAntes = b.classList.contains('collapsed');
    head.click();
    const colapsadoDespues = b.classList.contains('collapsed');
    const display = getComputedStyle(body).display;
    head.click();
    return {
      hay: !!b, rows, texto, colapsadoAntes, colapsadoDespues, display,
      expandido: getComputedStyle(body).display !== 'none',
      enDom: document.querySelectorAll('#msg-inner .hidden-from-agent').length,
      textoAhora: b.textContent.slice(0, 80),
    };
  });
  ok(band.hay, 'la banda .rw-band existe');
  ok(band.rows >= 1, 'la fila oculta esta DENTRO de la banda (' + band.rows + ' nodo/s)');
  ok(band.enDom >= 1, 'la fila oculta sigue en el DOM: ' + band.enDom);
  ok(!band.colapsadoAntes, 'arranca expandida: el usuario ve lo que el modelo no ve');
  ok(/El modelo no ve/.test(band.textoAhora), 'el encabezado lo explica: "' + band.textoAhora.replace(/\s+/g, ' ').slice(0, 60) + '"');
  ok(band.colapsadoDespues && band.display === 'none', 'se puede plegar (eleccion del usuario)');
  ok(band.expandido, 'y se vuelve a desplegar');

  // ---------- 4. densidad ----------
  console.log('4) densidad del transcript');
  const dens = await page.evaluate(() => {
    const w = window.__aegisWeb;
    const out = {};
    for (const d of ['comoda', 'compacta', 'lectura']) {
      w.view.setDensity(d);
      const el = document.querySelector('#msg-inner');
      const cs = getComputedStyle(el);
      out[d] = { measure: Math.round(parseFloat(cs.maxWidth)), gap: cs.gap, attr: document.querySelector('#messages').dataset.density };
    }
    return out;
  });
  ok(dens.comoda.measure === 760, 'cómoda: medida 760px (medido ' + dens.comoda.measure + ')');
  ok(dens.compacta.measure === 900, 'compacta: medida 900px (medido ' + dens.compacta.measure + ')');
  ok(dens.lectura.measure === 660, 'lectura: medida 660px (medido ' + dens.lectura.measure + ')');
  ok(dens.compacta.attr === 'compacta', 'la densidad queda en #messages[data-density]');

  // ---------- 5. modo presentación ----------
  console.log('5) modo presentación');
  await page.evaluate(() => window.__aegisWeb.view.setPresent(true));
  await page.waitForTimeout(200);
  const pres = await page.evaluate(() => ({
    on: document.documentElement.classList.contains('presentation'),
    sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
    topbar: getComputedStyle(document.querySelector('.topbar')).display,
    composer: getComputedStyle(document.querySelector('.composer-wrap')).display,
    msgs: document.querySelector('#messages').clientHeight,
  }));
  ok(pres.on, 'la clase .presentation se aplica');
  ok(pres.sidebar === 'none' && pres.topbar === 'none' && pres.composer === 'none', 'sin barra de sesiones, cabecera ni compositor');
  ok(pres.msgs > 700, 'el transcript ocupa la pantalla (' + pres.msgs + 'px)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok(!(await page.evaluate(() => document.documentElement.classList.contains('presentation'))), 'Esc sale del modo presentación');

  // ---------- 6. estilos que se ven (no solo existencia) ----------
  console.log('6) lo que se ve, medido');
  const look = await page.evaluate(() => {
    const w = window.__aegisWeb;
    w.view.setDensity('comoda');
    document.querySelector('#runbar').hidden = false;
    w.view.setPhase('tool', 'prueba');
    w.markHiddenTail();
    const b = document.querySelector('.rw-band');
    const head = b.querySelector('.rw-band-head');
    const ico = b.querySelector('.rw-band-ico');
    const ph = document.querySelector('#runbar-phase');
    const csB = getComputedStyle(b);
    return {
      bandBorder: csB.borderTopStyle, bandRadius: csB.borderTopLeftRadius,
      headH: Math.round(head.getBoundingClientRect().height),
      icoW: Math.round(ico.getBoundingClientRect().width),
      phH: Math.round(ph.getBoundingClientRect().height),
      phMono: getComputedStyle(ph.querySelector('.rp-since') || ph).fontSize,
    };
  });
  ok(look.bandBorder === 'dashed', 'la banda se distingue del hilo vivo (borde ' + look.bandBorder + ')');
  ok(look.headH >= 24, 'el encabezado es tocable (' + look.headH + 'px de alto)');
  ok(look.icoW >= 11, 'el icono del encabezado se pinta (' + look.icoW + 'px)');
  ok(look.phH >= 18 && look.phH <= 24, 'la fase es una píldora compacta (' + look.phH + 'px)');

  await page.screenshot({ path: OUT + '/escritorio-1440.png', fullPage: false });

  // móvil: mismo contenido, otra medida
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const mov = await page.evaluate(() => {
    const w = window.__aegisWeb;
    w.view.setPhase('tool', 'prueba');
    w.markHiddenTail();
    const b = document.querySelector('.rw-band');
    const ph = document.querySelector('#runbar-phase');
    const r = b.getBoundingClientRect();
    return { bandW: Math.round(r.width), overflowX: document.documentElement.scrollWidth > window.innerWidth,
      phW: Math.round(ph.getBoundingClientRect().width), hint: getComputedStyle(b.querySelector('.rw-band-hint')).display };
  });
  ok(!mov.overflowX, 'sin desborde horizontal a 390px');
  ok(mov.bandW <= 390, 'la banda entra en el ancho del teléfono (' + mov.bandW + 'px)');
  ok(mov.phW > 0 && mov.phW < 200, 'la fase entra en la barra angosta (' + mov.phW + 'px)');
  ok(mov.hint === 'none', 'en el teléfono se esconde la coletilla, no el dato');
  await page.screenshot({ path: OUT + '/movil-390.png', fullPage: false });

  ok(errs.length === 0, 'cero errores de página/consola: ' + JSON.stringify(errs.slice(0, 4)));

  console.log(fails ? '\nFALLARON ' + fails + ' comprobaciones' : '\nPASS capa visual (iconos, fases, banda de ocultos, densidad, presentación)');
  console.log('capturas: ' + OUT);
  process.exitCode = fails ? 1 : 0;
} finally {
  await browser.close();
}
