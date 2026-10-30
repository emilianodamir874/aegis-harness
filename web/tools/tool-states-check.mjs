// Estados animados de la tarjeta de herramienta, contra el node vivo.
// Dos pruebas: (a) el CSS con markup sintetico identico al que emite app.ts,
// (b) tarjetas reales de una sesion (data-state y tico-* puestos por el JS).
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 140)));
await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);

// (b) sesion real con tarjetas de herramienta
await page.locator('.sb-item').first().click().catch(() => {});
await page.waitForTimeout(2500);
const real = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll('#msg-inner .tool')).slice(-4);
  return {
    count: document.querySelectorAll('#msg-inner .tool').length,
    sample: cards.map((el) => ({
      state: el.dataset.state || null,
      kind: el.dataset.kind || null,
      icon: (el.querySelector('svg.tico') || {}).getAttribute ? el.querySelector('svg.tico').getAttribute('class') : null,
      spin: !!el.querySelector('.spin'),
    })),
  };
});

// (a) CSS con markup sintetico
const css = await page.evaluate(() => {
  const host = document.querySelector('#msg-inner');
  const mk = (kind, title, state, iconCls) => {
    const el = document.createElement('div');
    el.className = 'tool';
    el.dataset.state = state;
    el.dataset.kind = kind;
    el.innerHTML = '<span class="tool-ic"><svg class="tico ' + iconCls + ' tico-' + kind + '" viewBox="0 0 16 16">'
      + '<path d="M3 3 5 5"/></svg></span><div class="tool-body"><div class="tool-title">' + title
      + ' <span class="tname">' + kind + '</span></div></div>';
    host.appendChild(el);
    const svg = el.querySelector('svg');
    const ic = el.querySelector('.tool-ic');
    return {
      state: el.dataset.state,
      iconColor: getComputedStyle(svg).color,
      iconAnim: getComputedStyle(svg).animationName,
      ringAnim: getComputedStyle(ic, '::after').animationName,
      cardAnim: getComputedStyle(el, '::after').animationName,
      cardEnter: getComputedStyle(el).animationName,
    };
  };
  const out = {
    run: mk('shell', 'git status', 'run', 'is-running'),
    ok: mk('read', 'app.ts', 'ok', 'is-done'),
    err: mk('delete', 'borrar', 'err', 'is-err'),
  };
  return out;
});
await page.evaluate(() => document.querySelector('#msg-inner').scrollIntoView({ block: 'end' }));
await page.waitForTimeout(500);
await page.screenshot({ path: 'C:/Aegis-Proyects/web/outbox/_shots/v11-tools.png' });
console.log(JSON.stringify({ real, css, errs }, null, 1));

const checks = [
  ['run: anillo gira', css.run.ringAnim === 'rot'],
  ['run: barra indeterminada', css.run.cardAnim === 'runSlide'],
  ['run: icono en acento', css.run.iconColor === 'rgb(217, 119, 87)'],
  ['run: icono respira, no es spinner', css.run.iconAnim === 'breathe'],
  ['ok: pop del icono', css.ok.iconAnim === 'okPop'],
  ['err: sacudida', /shake/.test(css.err.cardEnter)],
  ['entrada de tarjeta', /toolIn/.test(css.ok.cardEnter)],
  ['sin errores de pagina', errs.length === 0],
];
const bad = checks.filter(([, v]) => !v);
for (const [n, v] of checks) console.log((v ? 'PASS ' : 'FAIL ') + n);
console.log('VERDICT', bad.length ? 'FALLA' : 'OK', '| tarjetas reales:', real.count);
if (bad.length) process.exit(1);
await browser.close();
