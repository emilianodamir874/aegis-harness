// Gate del chip de modelo con esfuerzo al costado (2026-10-28).
//
// Contrato: la barra tiene UN chip para modelo+esfuerzo. El esfuerzo no gasta un botón propio;
// viaja como sub-chip del modelo elegido y, al abrir la lista, cada modelo abre su flyout de
// esfuerzos al costado. Elegir un esfuerzo del flyout fija modelo + esfuerzo en un solo gesto.
//
// Todo con una sesión FALSA inyectada en el estado: no abre chat, no manda prompts y no toca
// configOptions del server (setConfig está interceptado por el propio gate).
//
//   node tools/chip-effort-check.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = (process.argv[2] || process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788').replace(/\/+$/, '');
const OUT = 'C:/Users/Emiliano/backups/chip-effort-20261028';
mkdirSync(OUT, { recursive: true });

let fails = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { fails++; console.log('  FAIL ' + msg); } };

const FIJO = {
  provider: { id: 'provider', name: 'Proveedor', type: 'select', currentValue: 'open_design', options: [
    { value: 'open_design', name: 'Open Design' }, { value: 'opencode_go', name: 'OpenCode Go' }, { value: 'chatgpt_codex', name: 'ChatGPT Codex' }] },
  mode: { id: 'mode', name: 'Modo', type: 'select', currentValue: 'auto', options: [
    { value: 'auto', name: 'Auto' }, { value: 'chat', name: 'Chat' }] },
  model: { id: 'model', name: 'Modelo', type: 'select', currentValue: 'deepseek-v4.1-flash', options: [
    { value: 'deepseek-v4.1-flash', name: 'DeepSeek v4.1 Flash' },
    { value: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
    { value: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash' }] },
  thinking_effort: { id: 'thinking_effort', name: 'Esfuerzo', type: 'select', currentValue: 'low', options: [
    { value: 'off', name: 'off' }, { value: 'low', name: 'low' }, { value: 'medium', name: 'medium' },
    { value: 'high', name: 'high' }, { value: 'max', name: 'max' }] },
};

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForFunction(() => window.__aegisWeb?.chips, null, { timeout: 20000 });
  await page.waitForTimeout(1200);

  // Sesión falsa + setConfig interceptado (el gate no puede cambiar el server ni gastar un turno).
  await page.evaluate((fijo) => {
    const w = window.__aegisWeb;
    w.__probe = { calls: [] };
    w.state.current = { id: 'chip-probe', title: 'probe', configOptions: [fijo.provider, fijo.mode, fijo.model, fijo.thinking_effort] };
    // setConfig real pide session/set_config_option: se reemplaza por un registro y se
    // reproduce el efecto que importa (mover el currentValue + re-render) sin red.
    w.chips.setAplicar((configId, value) => {
      w.__probe.calls.push(configId + '=' + value);
      const opt = w.state.current.configOptions.find((o) => o.id === configId);
      if (opt) opt.currentValue = value;
    });
    w.chips.render();
  }, FIJO);
  await page.waitForTimeout(300);

  console.log('1) la barra ahorra el chip de esfuerzo');
  const bar = await page.evaluate(() => {
    const wraps = [...document.querySelectorAll('#chips .chip-wrap')].map((x) => x.dataset.opt);
    const chipModelo = document.querySelector('#chips .chip-wrap[data-opt="model"] .chip');
    return {
      wraps,
      effortWrap: !!document.querySelector('#chips .chip-wrap[data-opt="thinking_effort"]'),
      chipTexto: chipModelo ? chipModelo.textContent.replace(/\s+/g, ' ').trim() : '',
      chipEff: chipModelo && chipModelo.querySelector('.chip-eff') ? chipModelo.querySelector('.chip-eff').textContent.trim() : '',
      chipEffW: chipModelo && chipModelo.querySelector('.chip-eff') ? Math.round(chipModelo.querySelector('.chip-eff').getBoundingClientRect().width) : 0,
    };
  });
  ok(!bar.effortWrap, 'NO hay chip de esfuerzo suelto en la barra');
  ok(bar.wraps.includes('model') && bar.wraps.includes('provider'), 'siguen los chips de proveedor y modelo: ' + bar.wraps.join(','));
  ok(/DeepSeek/i.test(bar.chipTexto), 'el chip muestra el modelo: "' + bar.chipTexto + '"');
  ok(bar.chipEff.toLowerCase() === 'bajo', 'el chip lleva el esfuerzo como sub-chip: "' + bar.chipEff + '"');
  ok(bar.chipEffW > 20, 'el sub-chip se pinta de verdad (' + bar.chipEffW + 'px)');

  console.log('2) el flyout de esfuerzos se abre al costado de la fila');
  const fly = await page.evaluate(async () => {
    document.querySelector('#chips .chip-wrap[data-opt="model"] .chip').click();
    await new Promise((r) => setTimeout(r, 120));
    const menu = document.querySelector('body > .menu-model');
    const rows = [...(menu ? menu.querySelectorAll('.menu-row') : [])];
    const fila = rows[1];
    fila.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 320));
    const f = document.querySelector('body > .menu-fly');
    const rr = fila.getBoundingClientRect();
    const fr = f ? f.getBoundingClientRect() : null;
    return {
      hayMenu: !!menu, filas: rows.length,
      subEffort: rows.map((x) => (x.querySelector('.mr-eff-t') || {}).textContent || ''),
      hayFly: !!f,
      flyRows: f ? f.querySelectorAll('.menu-row').length : 0,
      alCostado: !!(fr && fr.left >= rr.right - 1),      // a la derecha de la fila
      alineado: !!(fr && rr && Math.abs(fr.top - rr.top) <= 120),
      tops: fr && rr ? { fila: Math.round(rr.top), fly: Math.round(fr.top), filaH: Math.round(rr.height), flyH: Math.round(fr.height) } : null,
      dentro: !!(fr && fr.right <= window.innerWidth + 1 && fr.left >= 0 && fr.bottom <= window.innerHeight + 1),
      barras: f ? f.querySelectorAll('.fly-bars i').length : 0,
      sel: f ? (f.querySelector('.menu-row.sel') || {}).textContent : null,
      hint: (menu ? menu.querySelector('.menu-hint') : {}).textContent || '',
    };
  });
  ok(fly.hayMenu, 'el menú de modelos abre');
  ok(fly.filas === 3, 'una fila por modelo (' + fly.filas + ')');
  ok(fly.subEffort.every((t) => t.length > 0), 'cada fila muestra su esfuerzo: ' + JSON.stringify(fly.subEffort));
  ok(fly.hayFly, 'pasar por la fila abre el flyout');
  ok(fly.flyRows === 5, 'el flyout trae los 5 esfuerzos (' + fly.flyRows + ')');
  ok(fly.alCostado, 'el flyout se abre AL COSTADO de la fila, no encima');
  ok(fly.alineado, 'alineado con la fila que lo abrió ' + JSON.stringify(fly.tops));
  ok(fly.dentro, 'el flyout queda dentro del viewport');
  ok(fly.barras === 25, 'cada esfuerzo dibuja sus 5 barras (' + fly.barras + ')');
  ok(/Bajo|bajo|low/i.test(String(fly.sel)), 'el flyout marca el esfuerzo vigente: "' + String(fly.sel).trim() + '"');
  ok(/Pasá por un modelo/i.test(fly.hint), 'el menú explica el gesto sin ocupar la barra');
  await page.screenshot({ path: OUT + '/flyout-1440.png' });

  console.log('3) elegir esfuerzo fija modelo + esfuerzo en un gesto');
  const pick = await page.evaluate(async () => {
    const f = document.querySelector('body > .menu-fly');
    const rows = [...f.querySelectorAll('.menu-row')];
    rows[4].click(); // max
    await new Promise((r) => setTimeout(r, 150));
    return {
      calls: window.__aegisWeb.__probe.calls.slice(),
      flyCerrado: !document.querySelector('body > .menu-fly'),
      menuCerrado: !document.querySelector('body > .menu-model') || document.querySelector('body > .menu-model').hidden,
      chipEff: (document.querySelector('#chips .chip-eff') || {}).textContent || '',
    };
  });
  ok(pick.calls.includes('model=glm-5.3-flash'), 'fija el modelo de la fila que abrió el flyout (glm): ' + JSON.stringify(pick.calls));
  ok(pick.calls.includes('thinking_effort=max'), 'fija el esfuerzo elegido: ' + JSON.stringify(pick.calls));
  ok(pick.flyCerrado && pick.menuCerrado, 'los dos menús se cierran al elegir');
  ok(/máximo/i.test(pick.chipEff), 'el chip queda con el esfuerzo nuevo: "' + pick.chipEff.trim() + '"');

  console.log('4) teclado y memoria por modelo');
  const kb = await page.evaluate(async () => {
    document.querySelector('#chips .chip-wrap[data-opt="model"] .chip').click();
    await new Promise((r) => setTimeout(r, 120));
    const menu = document.querySelector('body > .menu-model');
    const rows = [...menu.querySelectorAll('.menu-row')];
    rows[0].focus();
    rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const f = document.querySelector('body > .menu-fly');
    const abierto = !!f && !f.hidden;
    const focoEnFly = !!(f && f.contains(document.activeElement));
    const memo = window.__aegisWeb.chips.memo();
    (f || document).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return {
      abierto, focoEnFly, memo,
      cerrado: !document.querySelector('body > .menu-fly'),
      vuelveAFila: !!(document.activeElement && document.activeElement.classList.contains('menu-row')),
    };
  });
  ok(kb.abierto, 'ArrowRight abre el flyout de la fila enfocada');
  ok(kb.focoEnFly, 'el foco entra al flyout (sin mouse)');
  ok(kb.cerrado, 'Escape cierra el flyout');
  ok(kb.vuelveAFila, 'Escape devuelve el foco a la fila del modelo');
  ok(kb.memo && kb.memo['glm-5.3-flash'] === 'max', 'el esfuerzo elegido se recuerda por modelo: ' + JSON.stringify(kb.memo));
  console.log('5) teléfono: el flyout cae debajo y no se sale');
  await page.evaluate(() => { document.querySelectorAll('body > .menu').forEach((m) => m.remove()); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const mov = await page.evaluate(async () => {
    window.__aegisWeb.chips.render();
    const chip = document.querySelector('#chips .chip-wrap[data-opt="model"] .chip');
    chip.click();
    await new Promise((r) => setTimeout(r, 140));
    const rows = [...document.querySelectorAll('body > .menu-model .menu-row')];
    rows[2].dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 320));
    const f = document.querySelector('body > .menu-fly');
    const fr = f ? f.getBoundingClientRect() : null;
    return {
      hay: !!f,
      dentro: !!(fr && fr.left >= -1 && fr.right <= window.innerWidth + 1 && fr.top >= -1 && fr.bottom <= window.innerHeight + 1),
      ancho: fr ? Math.round(fr.width) : 0,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      chipW: Math.round(chip.getBoundingClientRect().width),
    };
  });
  ok(mov.hay, 'en el teléfono el flyout también abre');
  ok(mov.dentro, 'entra completo en 390x844 (' + mov.ancho + 'px de ancho)');
  ok(!mov.overflowX, 'sin desborde horizontal');
  ok(mov.chipW < 300, 'el chip modelo+esfuerzo no invade la barra (' + mov.chipW + 'px)');
  await page.screenshot({ path: OUT + '/movil-390.png' });

  ok(errs.length === 0, 'cero errores de página/consola: ' + JSON.stringify(errs.slice(0, 4)));

  console.log(fails ? '\nFALLARON ' + fails + ' comprobaciones' : '\nPASS chip de modelo con esfuerzo al costado');
  console.log('capturas: ' + OUT);
  process.exitCode = fails ? 1 : 0;
} finally {
  await browser.close();
}
