// Verifica por DOM que el popover de contexto abra SIEMPRE dentro del viewport.
//
// Uso:  node tools/usage-pop-clamp-check.mjs [url] [--headed]
//       npm run pop-clamp-check
//
// Por que existe: /compact y el clamp del popover se probaron a ojo. `node --check` no mira
// geometria y el healthz no mira HTML. Esto mide el rectangulo real de #usage-pop contra
// window.visualViewport en los tamaños donde el panel no entra: telefono chico, viewport con
// poca altura y un desglose mas alto que la pantalla.
//
// Es read-only sobre el serve: solo carga la pagina, inyecta `state.usage` y hace click en
// #btn-gasto-top (no manda prompts ni toca sesiones).

import { chromium } from 'playwright';

const url = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:3788/';
const headed = process.argv.includes('--headed');

// Un desglose realista: 5 partes de contexto + una fila por modelo + compactacion interna.
function payload({ breakdownRows = 5, modelRows = 3 } = {}) {
  const labels = [
    'resultados de herramientas', 'mensajes del historial', 'prompt del sistema',
    'esquemas de tools', 'historial oculto por compactar', 'resumen de compactacion',
    'mensajes de sub-agentes', 'archivos leidos', 'salida de builds', 'logs del serve',
    'llamadas al modelo', 'razonamiento', 'adjuntos', 'otros'
  ];
  const contextBreakdown = labels.slice(0, breakdownRows).map((label, i) => ({
    label,
    tokens: 40000 - i * 2400,
    count: 12 + i,
    detail: 'detalle ' + i + ': path/al/archivo-' + i + '.rs y una nota corta'
  }));
  const models = ['openai/gpt-6-sol', 'anthropic/claude-5-opus', 'deepseek/deepseek-v4', 'antigravity/gemini-4-pro',
    'openai/gpt-6-mini', 'anthropic/claude-5-haiku', 'deepseek/deepseek-v4-mini', 'antigravity/gemini-4-flash'];
  return {
    used: 412000,
    limit: 500000,
    inTok: 1234567,
    outTok: 45678,
    cost: 3.21,
    last: { inputTokens: 90000, outputTokens: 3000, cacheReadTokens: 45000, elapsedMs: 12300, timeToFirstTokenMs: 2100 },
    contextBreakdown,
    modelUsage: models.slice(0, modelRows).map((m, i) => {
      const [provider, model] = m.split('/');
      return { provider, model, calls: 5 + i, inputTokens: 120000 - i * 9000, outputTokens: 9000 - i * 500 };
    }),
    compactionCalls: 3,
    compactionInputTokens: 120000,
    compactionOutputTokens: 4000
  };
}

const scenarios = [
  { name: 'desktop 1440x900 (panel completo)', viewport: { width: 1440, height: 900 }, data: payload({ breakdownRows: 5, modelRows: 3 }) },
  { name: 'telefono 390x844 (panel alto)', viewport: { width: 390, height: 844 }, data: payload({ breakdownRows: 6, modelRows: 4 }) },
  { name: 'telefono 390x844 con desglose enorme', viewport: { width: 390, height: 844 }, data: payload({ breakdownRows: 14, modelRows: 8 }) },
  { name: 'viewport bajo 390x480', viewport: { width: 390, height: 480 }, data: payload({ breakdownRows: 10, modelRows: 6 }) },
];

const failures = [];
const browser = await chromium.launch({ headless: !headed });
try {
  for (const s of scenarios) {
    const ctx = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // `state`: el readout esta vacio hasta que llega el primer uso, asi que existe pero no es visible.
    await page.waitForSelector('#btn-gasto-top', { state: 'attached', timeout: 20000 });
    await page.waitForFunction(() => !!(window.__aegisWeb && window.__aegisWeb.state), null, { timeout: 20000 });

    await page.evaluate((usage) => {
      const w = window.__aegisWeb;
      w.state.usage = usage;
      w.renderUsagePublic();
    }, s.data);

    const opened = await page.evaluate(() => {
      const el = document.querySelector('#btn-gasto-top');
      el.click();
      const pop = document.querySelector('#usage-pop');
      return !!(pop && !pop.hidden);
    });

    const geom = async () => page.evaluate(() => {
      const pop = document.querySelector('#usage-pop');
      const r = pop.getBoundingClientRect();
      const vv = window.visualViewport;
      const vw = (vv && vv.width) || window.innerWidth;
      const vh = (vv && vv.height) || window.innerHeight;
      return {
        x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
        vw, vh, above: pop.dataset.above, naturalH: pop.scrollHeight, maxH: pop.style.maxHeight
      };
    });

    let g = await geom();
    const inside = (m) =>
      m.x >= -0.5 && m.y >= -0.5 && m.right <= m.vw + 0.5 && m.bottom <= m.vh + 0.5;

    const problems = [];
    if (!opened) problems.push('el popover no se abrio');
    if (opened && !inside(g)) problems.push(`abre fuera del viewport: rect(${Math.round(g.x)},${Math.round(g.y)} ${Math.round(g.w)}x${Math.round(g.h)}) vs ${g.vw}x${g.vh}`);
    if (opened && g.h > g.vh) problems.push(`el panel (${Math.round(g.h)}px) es mas alto que el viewport (${Math.round(g.vh)}px) y no lo limita maxHeight=${g.maxH}`);

    // Reubicacion: el chat scrollea (listener de scroll en captura) y el panel tiene que seguir adentro.
    await page.evaluate(() => {
      const box = document.querySelector('#messages');
      if (box) box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight - 400);
    });
    await page.waitForTimeout(150);
    const g2 = await geom();
    if (opened && !inside(g2)) problems.push(`tras el scroll queda fuera: rect(${Math.round(g2.x)},${Math.round(g2.y)} ${Math.round(g2.w)}x${Math.round(g2.h)})`);

    if (consoleErrors.length) problems.push('errores de consola: ' + consoleErrors.slice(0, 2).join(' | '));

    // Contraste: donde habria quedado con la logica vieja (innerWidth/innerHeight, sin techo
    // de alto). Documenta el bug, no solo la ausencia de bug.
    const legacy = await page.evaluate(() => {
      const pop = document.querySelector('#usage-pop');
      const a = document.querySelector('#btn-gasto-top');
      const r = a.getBoundingClientRect();
      const pw = pop.offsetWidth;
      const ph = pop.scrollHeight;
      let top = r.top - ph - 9;
      const above = top >= 8;
      if (!above) top = r.bottom + 9;
      const left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8));
      return { left: Math.round(left), top: Math.round(Math.max(8, top)), h: ph, above };
    });
    const legacyOutside = legacy.top + legacy.h > g.vh + 0.5 || legacy.left + g.w > g.vw + 0.5 || legacy.top < 0 || legacy.left < 0;

    const label = problems.length ? 'FALLA' : 'ok  ';
    console.log(`[${label}] ${s.name}: rect(${Math.round(g.x)},${Math.round(g.y)}) ${Math.round(g.w)}x${Math.round(g.h)}` +
      ` viewport ${g.vw}x${g.vh} above=${g.above} natural=${g.naturalH} maxH=${g.maxH || '-'}` +
      (problems.length ? `\n         -> ${problems.join('; ')}` : '') +
      (legacyOutside ? `\n         (logica vieja: rect(${legacy.left},${legacy.top}) alto ${legacy.h} -> se salia)` : ''));
    if (problems.length) failures.push(`${s.name}: ${problems.join('; ')}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.log(`\n${failures.length} escenario(s) con problemas.`);
  process.exit(1);
}
console.log('\nTodos los escenarios: el popover queda dentro del viewport.');
