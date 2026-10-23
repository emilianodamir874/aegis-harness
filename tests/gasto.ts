// Prueba del panel "Gasto" en desktop (1440x950): KPIs, tablas, cambio de rango y endpoint.
// Read-only sobre /stats.json.
import { chromium } from 'playwright';
import { baseUrl, check, pass, openPage } from './lib.js';

const url = baseUrl();
const browser = await chromium.launch({ headless: true });
try {
  const page = await openPage(browser, { viewport: { width: 1440, height: 950 } });
  const errs: string[] = [];
  page.on('pageerror', (e: Error) => errs.push(e.message));

  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3500);
  await page.evaluate(() => (document.getElementById('btn-gasto-top') as HTMLElement).click());
  await page.waitForTimeout(5000);

  const p1 = await page.evaluate(() => ({
    open: (document.getElementById('st-overlay') as HTMLElement).dataset.open,
    sub: (document.querySelector('#st-sub') as HTMLElement).textContent,
    kpis: [...document.querySelectorAll('.st-kpi')].map((k) => (k.querySelector('.v') as HTMLElement).textContent),
    bars: document.querySelectorAll('.st-bars .b').length,
    modelRows: document.querySelectorAll('table.st-t tbody tr').length,
    foot: (document.querySelector('.st-foot') as HTMLElement).textContent,
  }));
  check(p1.open === '1', 'panel abierto');
  check(p1.kpis.length === 6 && p1.kpis.every((v) => v && v !== '—'), 'KPIs con valor: ' + JSON.stringify(p1.kpis));
  check((p1.bars || 0) > 0, 'barras por dia: ' + p1.bars);
  check((p1.modelRows || 0) > 0, 'filas de modelos/sesiones: ' + p1.modelRows);
  check(/percentiles/.test(p1.foot || ''), 'pie con percentiles');

  // «vs plan»: la seccion existe siempre; con planes declarados muestra la linea de resumen y
  // sin planes muestra el aviso de configurarlo. Nunca inventa precios.
  const plan = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.st-sec')].map((s) => (s.textContent || '').trim());
    const linea = document.querySelector('.st-plan-line');
    const warns = [...document.querySelectorAll('.st-warn')].map((w) => (w.textContent || '').trim()).join(' | ');
    const tablaPlan = [...document.querySelectorAll('table.st-t')].find((t) => /Plan del per/i.test(t.textContent || ''));
    return {
      sec: secs.some((s) => /^Contra el plan/.test(s)),
      linea: linea ? linea.textContent : '',
      warns,
      columnas: tablaPlan ? [...tablaPlan.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim()) : [],
      filas: tablaPlan ? tablaPlan.querySelectorAll('tbody tr').length : 0,
    };
  });
  check(plan.sec, 'seccion «Contra el plan» presente');
  check(plan.filas > 0, 'tabla vs plan con filas: ' + plan.filas);
  check(plan.columnas.join('|').includes('Consumo estimado') && plan.columnas.join('|').includes('Diferencia'), 'columnas vs plan: ' + plan.columnas.join('|'));
  check(
    /contra planes:/.test(plan.linea) || /Declar. el plan en config\.json/.test(plan.warns),
    'vs plan: linea de resumen o aviso de configuracion: ' + plan.linea + ' / ' + plan.warns.slice(0, 160),
  );

  // cambio de rango 30d -> 7d
  const sub30 = p1.sub || '';
  await page.click('#st-seg button[data-days="7"]');
  await page.waitForTimeout(4500);
  const p2 = await page.evaluate(() => ({
    sub: (document.querySelector('#st-sub') as HTMLElement).textContent,
    on: (document.querySelector('#st-seg button[data-days="7"]') as HTMLElement).getAttribute('data-on'),
  }));
  check(p2.on === '1', 'boton 7d marcado');
  check(p2.sub !== sub30 && /7 d/.test(p2.sub || ''), 'subtitulo cambio a 7 dias: ' + p2.sub);

  // endpoint crudo
  const raw = await page.evaluate(async () => {
    const r = await fetch('/stats.json?days=30', { credentials: 'same-origin' });
    const j = await r.json();
    return { status: r.status, keys: Object.keys(j), cost: j.totals && j.totals.cost, calls: j.totals && j.totals.calls };
  });
  check(raw.status === 200, '/stats.json 200');
  check(raw.keys.includes('totals') && raw.keys.includes('daily') && raw.keys.includes('models'), 'claves esperadas: ' + raw.keys.join(','));
  check(typeof raw.cost === 'number' && raw.calls > 0, 'totales numericos: cost=' + raw.cost + ' calls=' + raw.calls);
  check(errs.length === 0, 'sin errores de pagina: ' + JSON.stringify(errs));
  pass('panel Gasto contra ' + url + ' (' + raw.calls + ' llamadas, USD ' + Number(raw.cost).toFixed(2) + ')');
} finally {
  await browser.close();
}
