// Verifica que el ritmo de generacion (tok/s) se vea y diga lo mismo en sus tres lugares:
// el badge del runbar en vivo (estimado), el badge + promedio al cerrar el turno, la marca de
// fin de turno que queda en la conversacion, y la fila del popover de contexto.
//
// Uso: node tools/runbar-tps-check.mjs [url]
// Escribe capturas en C:/Users/Emiliano/backups/runbar-tps-<escenario>.png
//
// Es read-only sobre el serve: carga la pagina, alimenta el velocimetro con los hooks de
// __aegisWeb (speedStart/speedFeed/speedFinish) y mira el DOM. No manda prompts.

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

    // Runbar visible, como durante un turno.
    await page.evaluate(() => {
      document.querySelector('#runbar').hidden = false;
      document.querySelector('#runbar-text').textContent = 'Aegis esta trabajando…';
      document.querySelector('#runbar-time').textContent = '3.4 s';
      window.__aegisWeb.speedStart();
    });

    // En vivo: 6 tandas de 400 chars cada 250 ms (≈2400 chars en 1,5 s ≈ 400 tok/s estimados).
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.__aegisWeb.speedFeed('x'.repeat(400)));
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(320);
    const live = await page.evaluate(() => {
      const el = document.querySelector('#runbar-tps');
      const cs = getComputedStyle(el);
      return {
        text: el.textContent, hidden: el.hidden, bg: cs.backgroundColor,
        border: cs.borderTopWidth, font: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, color: cs.color
      };
    });
    check('badge en vivo con etiqueta ~N tok/s', /^~\d+(\.\d+)? tok\/s$/.test(live.text), JSON.stringify(live.text));
    check('badge visible durante el stream', !live.hidden);
    check('badge es una pill (fondo + borde propios, no hereda el texto del runbar)',
      live.bg !== 'rgba(0, 0, 0, 0)' && parseFloat(live.border) > 0,
      `bg=${live.bg} border=${live.border}`);
    check('badge en monoespaciada y negrita', /mono|consol|courier/i.test(live.font) && Number(live.weight) >= 600,
      `font=${live.font} weight=${live.weight}`);
    await page.locator('#runbar').screenshot({ path: outDir + 'runbar-tps-' + s.name + '-vivo.png' });

    // Cierre del turno: exacto del ultimo paso + promedio ponderado + total.
    const done = await page.evaluate(() => {
      const st = window.__aegisWeb.state.speed;
      st.exact = 43.26; st.runOut = 4123; st.runGen = 98000;
      document.querySelector('#runbar').classList.add('done'); // como runBarDone
      const sum = window.__aegisWeb.speedFinish();
      const badge = document.querySelector('#runbar-tps');
      const avg = document.querySelector('#runbar-avg');
      const order = [...document.querySelectorAll('#runbar > *')].map((n) => n.id || n.className);
      return {
        sum, badge: badge.textContent, badgeHidden: badge.hidden, badgeBg: getComputedStyle(badge).backgroundColor,
        avg: avg.textContent, avgHidden: avg.hidden, order
      };
    });
    check('badge exacto al cerrar (43.3 tok/s)', done.badge === '43.3 tok/s', JSON.stringify(done.badge));
    check('promedio del turno (prom 42.1 tok/s · 4123 tok)', done.avg === 'prom 42.1 tok/s · 4123 tok', JSON.stringify(done.avg));
    check('badge verde en done', done.badgeBg.includes('85, 165, 131'), done.badgeBg);
    check('orden del runbar: texto · tiempo · badge · promedio · detener',
      done.order.join(',') === 'runbar-spin,runbar-text,runbar-time,runbar-tps,runbar-avg,runbar-stop', done.order.join(','));
    await page.locator('#runbar').screenshot({ path: outDir + 'runbar-tps-' + s.name + '-fin.png' });

    // Marca de fin de turno en la conversacion (es lo unico que queda cuando el runbar se va).
    const note = await page.evaluate(() => {
      window.__aegisWeb.turnEndNote(12300);
      const el = [...document.querySelectorAll('.turn-end')].pop();
      const tps = el.querySelector('.te-tps');
      return { text: el.textContent, tpsFont: tps ? getComputedStyle(tps).fontFamily : null, html: el.innerHTML.length };
    });
    check('marca de fin de turno con el ritmo',
      note.text.includes('fin del turno · 12.3 s') && note.text.includes('43.3 tok/s') && note.text.includes('prom 42.1 tok/s · 4123 tok'),
      JSON.stringify(note.text));
    check('el ritmo de la marca va en monoespaciada', /mono|consol|courier/i.test(note.tpsFont || ''), String(note.tpsFont));

    // Popover de contexto: el mismo numero, calculado de message_usage.
    const pop = await page.evaluate(() => {
      const w = window.__aegisWeb;
      w.state.usage = {
        used: 412000, limit: 500000, inTok: 1234567, outTok: 45678, cost: 3.21,
        last: { inputTokens: 90000, outputTokens: 3000, cacheReadTokens: 45000, elapsedMs: 12300, timeToFirstTokenMs: 2100 }
      };
      w.renderUsagePublic();
      document.querySelector('#meta-right').click();
      const popEl = document.querySelector('#usage-pop');
      return { hidden: popEl.hidden, rows: [...popEl.querySelectorAll('.up-row')].map((r) => r.textContent) };
    });
    check('el popover abre y su fila "ultimo paso" trae el ritmo',
      !pop.hidden && pop.rows.some((r) => r.includes('ultimo paso') && r.includes('294 tok/s')),
      JSON.stringify(pop.rows.slice(0, 2)));

    check('sin errores de consola', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(fails.length ? `\n${fails.length} falla(s).` : '\ntok/s visible y consistente en runbar, conversacion y popover.');
if (fails.length) process.exit(1);
