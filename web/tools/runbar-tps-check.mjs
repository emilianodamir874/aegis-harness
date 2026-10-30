// Comprueba en el navegador, contra la app servida, el contrato del ritmo de salida:
//   · el runbar muestra seis promedios de outputTokens recibidos del backend, no una tasa instantánea,
//   · la fila de seis promedios (5s, 15s, 30s, 1m, 5m, 15m) vive como segunda línea del runbar,
//     hermana del badge de fase y no dentro de él,
//   · los promedios salen de usage del backend y se vacían sin datos,
//   · la nota de fin de turno conserva el promedio ponderado.
//
// Uso: node tools/runbar-tps-check.mjs [url]
// Escribe capturas en C:/Users/Emiliano/backups/runbar-tps-<escenario>.png
// Es read-only sobre el serve: alimenta el velocímetro con los hooks de __aegisWeb y mira el DOM.

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3788/';
const outDir = 'C:/Users/Emiliano/backups/';
const scenarios = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'telefono', viewport: { width: 390, height: 844 } },
];

const fails = [];
const check = (label, ok, detail) => {
  console.log(`  [${ok ? 'ok  ' : 'FALLA'}] ${label}${detail ? ' -> ' + detail : ''}`);
  if (!ok) fails.push(label + (detail ? ': ' + detail : ''));
};

const browser = await chromium.launch({ headless: true });
try {
  for (const s of scenarios) {
    console.log(`\n=== ${s.name} (${s.viewport.width}x${s.viewport.height}) ===`);
    const ctx = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__aegisWeb && window.__aegisWeb.state), null, { timeout: 20000 });

    await page.evaluate(() => {
      const app = window.__aegisWeb;
      document.querySelector('#runbar').hidden = false;
      document.querySelector('#runbar-text').textContent = 'Aegis está trabajando…';
      document.querySelector('#runbar-time').textContent = '3.4 s';
      app.view?.setPhase?.('writing');
      app.speedReset();
      app.state.busy = true;
      app.speedStart();
    });
    await page.waitForTimeout(200);

    const initial = await page.evaluate(() => {
      const row = document.querySelector('#runbar-speed-windows');
      const phase = document.querySelector('#runbar-phase');
      const bar = document.querySelector('#runbar');
      const rr = row?.getBoundingClientRect();
      const pr = phase?.getBoundingClientRect();
      const br = bar?.getBoundingClientRect();
      return {
        cells: [...document.querySelectorAll('#runbar-speed-windows .runbar-speed-cell')].map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim()),
        hidden: !!row?.hidden,
        display: row ? getComputedStyle(row).display : null,
        parent: row?.parentElement?.id || null,
        parentClass: row?.parentElement?.classList.contains('composer-meta') || false,
        insidePhase: !!document.querySelector('#runbar-phase #runbar-speed-windows'),
        insideMeta: row?.parentElement?.classList.contains('composer-meta') || false,
        instant: !!document.querySelector('#runbar-tps') || !!document.querySelector('#runbar-avg'),
        belowPhase: !!(rr && pr && rr.top >= pr.bottom - 2),
        insideBar: !!(rr && br && rr.left >= br.left - 1 && rr.right <= br.right + 1 && rr.bottom <= br.bottom + 1),
        width: rr ? Math.round(rr.width) : 0
      };
    });
    check('no existe tok/s instantáneo', !initial.instant);
    check('seis ventanas en orden y vacías', initial.cells.length === 6 && initial.cells.map((x) => x.replace(/[^0-9a-z]/gi, '')).join(',') === '5s,15s,30s,1m,5m,15m' && initial.cells.every((x) => x.endsWith('—')), JSON.stringify(initial.cells));
    check('la fila se ve sin datos', !initial.hidden && initial.display !== 'none');
    check('metricas en composer-meta, fuera del runbar', initial.parentClass && initial.insideMeta && !initial.insidePhase, JSON.stringify({ parent: initial.parent, insideMeta: initial.insideMeta, insidePhase: initial.insidePhase }));
    check('fila debajo del runbar en composer-meta', initial.belowPhase && initial.insideMeta, JSON.stringify({ below: initial.belowPhase, insideMeta: initial.insideMeta }));
    await page.locator('#runbar').screenshot({ path: outDir + 'runbar-tps-' + s.name + '-vivo.png' });

    // Una muestra de usage medida: 250 outputTokens recién recibidos. Cada ventana los cuenta
    // enteros y los divide por su propio ancho fijo.
    const sample = await page.evaluate(() => {
      const app = window.__aegisWeb;
      app.state.speed.samples.push({ at: Date.now(), tokens: 250 });
      app.state.speed.observed = true;
      app.speedWindowPaint();
      return [...document.querySelectorAll('#runbar-speed-windows .runbar-speed-cell')].map((n) => (n.textContent || '').trim());
    });
    check('una muestra reciente se cuenta completa en cada ventana y se divide por su ancho', sample.join(',') === '5s50.0,15s16.7,30s8.3,1m4.2,5m0.8,15m0.3', JSON.stringify(sample));

    // El promedio ponderado de generación en la nota final se mantiene como métrica aparte.
    const done = await page.evaluate(() => {
      const app = window.__aegisWeb;
      const st = app.state.speed;
      st.runOut = 4123; st.runGen = 98000;
      app.state.busy = false;
      document.querySelector('#runbar').classList.add('done');
      const sum = app.speedFinish();
      return {
        sum,
        cells: [...document.querySelectorAll('#runbar-speed-windows .runbar-speed-cell')].map((n) => (n.textContent || '').trim()),
        instant: !!document.querySelector('#runbar-tps') || !!document.querySelector('#runbar-avg')
      };
    });
    check('el promedio del turno sale de la generación medida', done.sum.avg === 42.07142857142857 && done.sum.out === 4123, JSON.stringify(done.sum));
    check('las ventanas siguen visibles al terminar', done.cells.length === 6);
    check('no reaparece tasa instantánea al cerrar', !done.instant);
    await page.locator('.composer-meta').screenshot({ path: outDir + 'runbar-tps-' + s.name + '-fin.png' });
    const idle = await page.evaluate(() => {
      document.querySelector('#runbar').hidden = true;
      const row = document.querySelector('#runbar-speed-windows');
      const visible = !row.hidden && getComputedStyle(row).display !== 'none';
      window.__aegisWeb.state.speed.samples.forEach((sample) => { sample.at = Date.now() - 901000; });
      window.__aegisWeb.speedWindowPaint();
      return { visible, cells: [...row.querySelectorAll('.runbar-speed-cell')].map((n) => (n.textContent || '').trim()), timer: window.__aegisWeb.state.speed.timer };
    });
    check('metricas visibles con runbar oculto y muestras expiradas', idle.visible && idle.timer === 0 && idle.cells.length === 6 && idle.cells.every((x) => /0(?:\.0)?$/.test(x)), JSON.stringify(idle));

    // La nota que queda en la conversación cuando el runbar se va.
    const note = await page.evaluate(() => {
      window.__aegisWeb.state.speed.runOut = 4123;
      window.__aegisWeb.state.speed.runGen = 98000;
      window.__aegisWeb.turnEndNote(12300);
      const el = [...document.querySelectorAll('.turn-end')].pop();
      const tps = el.querySelector('.te-tps');
      return { text: el.textContent, font: tps ? getComputedStyle(tps).fontFamily : null };
    });
    check('la nota trae tiempo y promedio, sin tasa instantánea',
      note.text.includes('fin del turno · 12.3 s') && note.text.includes('prom generación 42.1 tok/s · 4123 tok') && !/últim[ao]/.test(note.text),
      JSON.stringify(note.text));
    check('el promedio de la nota va en monoespaciada', /mono|consol|courier/i.test(note.font || ''), String(note.font));

    // El panel de gasto no revienta ni pierde el desglose abierto al refrescarse en vivo.
    const panel = await page.evaluate(() => {
      const w = window.__aegisWeb;
      w.state.usage = { used: 412000, limit: 500000, inTok: 1234567, outTok: 45678, cost: 3.21, contextBreakdown: [{ label: 'sistema', tokens: 12000 }] };
      w.renderUsagePublic();
      document.querySelector('#btn-gasto-top').click();
      const body = document.querySelector('#usage-panel .gs-disclosure[data-gs-detail="contexto"] summary');
      body?.click();
      const before = document.querySelector('#usage-panel .gs-disclosure[data-gs-detail="contexto"]')?.open;
      w.refrescarGasto();
      const detail = document.querySelector('#usage-panel .gs-disclosure[data-gs-detail="contexto"]');
      return { open: !!before, stillThere: !!detail, stillOpen: !!detail?.open, hasBody: (detail?.querySelector('.gs-disclosure-body')?.innerHTML || '').length > 0 };
    });
    check('el desglose de contexto sobrevive al refresco en vivo', panel.open && panel.stillThere && panel.stillOpen && panel.hasBody, JSON.stringify(panel));

    check('sin errores de consola', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(fails.length ? `\n${fails.length} falla(s).` : '\nmetricas rolling persistentes en composer-meta, sin tasa instantánea.');
if (fails.length) process.exit(1);
