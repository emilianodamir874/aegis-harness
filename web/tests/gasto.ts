// Prueba del panel "Gasto y uso" (#usage-panel) en desktop 1440x950.
// Read-only sobre /stats.json. El panel se abre desde el ÚNICO disparador que queda: el botón de
// barras del topbar (#btn-gasto-top). El readout del pie (#meta-right) está oculto a propósito.
// Contrato: el panel abre compacto (totales + proyección + fila de cache) y las listas pesadas
// —barras por día, modelos, composición, chats y llamadas caras— se montan recién al desplegar.
import { chromium } from 'playwright';
import { baseUrl, check, pass, openPage } from './lib.js';

const url = baseUrl();
const browser = await chromium.launch({ headless: true });
try {
  const page = await openPage(browser, { viewport: { width: 1440, height: 950 } });
  const errs: string[] = [];
  page.on('pageerror', (e: Error) => errs.push(e.message));

  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  // Un solo acceso: el del topbar. El del pie no se ve ni ocupa lugar.
  const accesos = await page.evaluate(() => {
    const pie = document.querySelector<HTMLElement>('#meta-right');
    return {
      arriba: !!document.querySelector('#btn-gasto-top'),
      pieExiste: !!pie,
      pieOculto: !!pie && getComputedStyle(pie).display === 'none',
      pieSinArea: pie ? (() => { const r = pie.getBoundingClientRect(); return r.width === 0 && r.height === 0; })() : true,
    };
  });
  check(accesos.arriba, 'el disparador del topbar existe');
  check(accesos.pieExiste && accesos.pieOculto && accesos.pieSinArea, 'readout del pie oculto y sin área: ' + JSON.stringify(accesos));

  await page.evaluate(() => (document.getElementById('btn-gasto-top') as HTMLElement).click());
  await page.waitForFunction(() => !!document.querySelector('#usage-panel .gs-big'), null, { timeout: 15000 });
  await page.waitForTimeout(2000);

  const p1 = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#usage-panel')!;
    const r = panel.getBoundingClientRect();
    const txt = (sel: string) => (panel.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
    const det = panel.querySelector<HTMLDetailsElement>('.gs-disclosure[data-gs-detail="periodo"]');
    return {
      titulo: txt('.panel-title, h2'),
      sub: txt('.panel-sub'),
      tabs: [...panel.querySelectorAll('.gs-tab')].map((b) => (b as HTMLElement).dataset.dias || ''),
      tabOn: [...panel.querySelectorAll('.gs-tab.is-on')].map((b) => (b as HTMLElement).dataset.dias || ''),
      big: txt('.gs-big'),
      kpi: txt('.gs-kpi'),
      barras: panel.querySelectorAll('.gs-bar').length,
      hayDisclosure: !!det,
      abierto: !!det?.open,
      cuerpoVacio: (det?.querySelector('.gs-disclosure-body')?.innerHTML || '') === '',
      filas: [...panel.querySelectorAll('.gs-r')].map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim()),
      enPantalla: r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1,
    };
  });
  check(/Gasto y uso/.test(p1.titulo), 'título del panel: ' + p1.titulo);
  check(p1.tabs.length >= 3 && p1.tabOn.length === 1, 'pestañas de período con una activa: ' + p1.tabs.join(',') + ' · on=' + p1.tabOn);
  check(/US\$/.test(p1.big) && /llamadas/.test(p1.big) && /chats/.test(p1.big), 'gasto del período con llamadas y chats: ' + p1.big);
  check(/proyección mensual/.test(p1.kpi) && /US\$/.test(p1.kpi), 'proyección mensual: ' + p1.kpi);
  check(p1.barras === 0 && p1.hayDisclosure && !p1.abierto && p1.cuerpoVacio, 'el desglose pesado no se monta al abrir: ' + JSON.stringify({ barras: p1.barras, det: p1.hayDisclosure, abierto: p1.abierto }));
  check(p1.filas.some((t) => /cache/i.test(t)), 'fila de cache en el resumen: ' + JSON.stringify(p1.filas.slice(0, 4)));
  check(p1.enPantalla, 'el panel compacto entra en pantalla: ' + JSON.stringify({ titulo: p1.titulo, ok: p1.enPantalla }));

  // Al desplegar, el detalle se arma una sola vez y trae barras, cache y compactaciones.
  await page.locator('#usage-panel .gs-disclosure[data-gs-detail="periodo"] summary').click();
  await page.waitForFunction(() => !!document.querySelector('#usage-panel .gs-disclosure[data-gs-detail=periodo] .gs-disclosure-body .gs-bar'));
  const detalle = (await page.locator('#usage-panel .gs-disclosure[data-gs-detail="periodo"] .gs-disclosure-body').textContent()) || '';
  check(/cache/i.test(detalle), 'el desglose desplegado trae la fila de cache: ' + detalle.slice(0, 180));
  check(/Gasto por día/.test(detalle) && /Por modelo/.test(detalle) && /Qué se paga/.test(detalle), 'el desglose desplegado trae las tres secciones pesadas: ' + detalle.slice(0, 180));
  const antesBarras = await page.locator('#usage-panel .gs-disclosure-body .gs-bar').count();
  check(antesBarras >= 3, 'barras por día al desplegar: ' + antesBarras);

  // Cambiar de período cambia los datos y respeta lo que el operador ya abrió.
  const antes = p1.sub;
  const otro = p1.tabs.find((d) => d && d !== p1.tabOn[0]) || '7';
  await page.click(`#usage-panel .gs-tab[data-dias="${otro}"]`);
  await page.waitForTimeout(2500);
  const p2 = await page.evaluate(() => {
    const det = document.querySelector<HTMLDetailsElement>('#usage-panel .gs-disclosure[data-gs-detail="periodo"]');
    return {
      sub: (document.querySelector('#usage-panel .panel-sub')?.textContent || '').trim(),
      on: (document.querySelector('#usage-panel .gs-tab.is-on') as HTMLElement | null)?.dataset.dias || '',
      barras: document.querySelectorAll('#usage-panel .gs-disclosure-body .gs-bar').length,
      big: (document.querySelector('#usage-panel .gs-big')?.textContent || '').replace(/\s+/g, ' ').trim(),
      abierto: !!det?.open,
      cargado: !!(det?.querySelector<HTMLElement>('.gs-disclosure-body')?.dataset.loaded),
    };
  });
  check(p2.on === otro, 'pestaña activa cambió a ' + otro + ': ' + p2.on);
  check(p2.sub !== antes, 'subtítulo cambió con el período: ' + antes + ' → ' + p2.sub);
  check(p2.abierto && p2.cargado, 'el desglose abierto sobrevive al cambio de período: ' + JSON.stringify(p2));
  check(p2.barras > 0 || /US\$/.test(p2.big), 'los datos del período cambiaron (barras ' + antesBarras + ' → ' + p2.barras + ')');

  // El endpoint crudo que alimenta el panel.
  const raw = await page.evaluate(async () => {
    const r = await fetch('/stats.json?days=30', { credentials: 'same-origin' });
    const j = await r.json();
    return { status: r.status, keys: Object.keys(j), cost: j.totals && j.totals.cost, calls: j.totals && j.totals.calls };
  });
  check(raw.status === 200, '/stats.json 200');
  check(raw.keys.includes('totals') && raw.keys.includes('daily') && raw.keys.includes('models'), 'claves esperadas: ' + raw.keys.join(','));
  check(typeof raw.cost === 'number' && raw.calls > 0, 'totales numéricos: cost=' + raw.cost + ' calls=' + raw.calls);
  check(errs.length === 0, 'sin errores de página: ' + JSON.stringify(errs));
  pass('panel Gasto contra ' + url + ' (' + raw.calls + ' llamadas, USD ' + Number(raw.cost).toFixed(2) + ')');
} finally {
  await browser.close();
}
