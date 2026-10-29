// Gate visual de los modos: streaming real del cliente, tarjetas ACP y estilos.
// Uso: node tools/modos-check.mjs [url]
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:3788/';
const results = [];
const errors = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(String(error).slice(0, 180)));
page.on('console', (message) => {
  if (message.type() === 'error' && !/WebSocket|403/.test(message.text())) errors.push(message.text().slice(0, 180));
});

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__aegisWeb?.chips?.setModo && !!window.__aegisWeb?.feed && !!window.__aegisWeb?.toolFeed, null, { timeout: 20000 });

  async function limpiar() {
    await page.evaluate(() => {
      const messages = document.getElementById('messages');
      if (!messages) throw new Error('Falta #messages');
      messages.querySelectorAll('.msg-inner, #modo-cinta, #tail-pill, #status-pill').forEach((node) => node.remove());
    });
  }

  async function sembrarTurno(modo) {
    await limpiar();
    await page.evaluate((m) => {
      const web = window.__aegisWeb;
      const messages = document.getElementById('messages');
      const inner = document.createElement('div');
      inner.id = 'msg-inner';
      inner.className = 'msg-inner';
      messages.appendChild(inner);
      const user = document.createElement('div');
      user.className = 'msg-user in';
      user.dataset.modo = m;
      user.textContent = 'mensaje de prueba';
      inner.appendChild(user);
      web.chips.setModo(m);
      web.feed('modo-fixture-' + m, 'Texto de prueba con **negrita**.', false, false);
      web.flushRender();
    }, modo);
    await page.waitForFunction((m) => {
      const el = document.querySelector('.msg-a[data-modo="' + m + '"]');
      if (!el) return false;
      const style = getComputedStyle(el);
      if (m === 'plan') return style.borderLeftStyle === 'dotted';
      if (m === 'revisar') return /217, 164, 91/.test(style.borderTopColor);
      return /143, 192, 164/.test(style.borderLeftColor);
    }, modo, { timeout: 8000 });
    await page.waitForFunction(() => !!document.querySelector('.msg-a .content strong'));
  }

  const estilo = (selector, properties) => page.evaluate(([s, props]) => {
    const element = document.querySelector(s);
    if (!element) return null;
    const style = getComputedStyle(element);
    return Object.fromEntries(props.map((property) => [property, style.getPropertyValue(property)]));
  }, [selector, properties]);
  const pseudo = (selector, pseudoElement, property) => page.evaluate(([s, pseudo, prop]) => {
    const element = document.querySelector(s);
    return element ? getComputedStyle(element, pseudo).getPropertyValue(prop) : '';
  }, [selector, pseudoElement, property]);

  await sembrarTurno('plan');
  const plan = await page.evaluate(() => ({
    mode: document.getElementById('messages').dataset.modo,
    ribbon: document.querySelector('.modo-cinta')?.textContent || '',
    content: document.querySelector('.msg-a[data-modo="plan"] .content')?.innerHTML || '',
  }));
  check('la cinta comunica que plan no escribe', plan.mode === 'plan' && /plan · no escribe/.test(plan.ribbon), JSON.stringify(plan));
  check('el stream real conserva markdown normal', /<strong>negrita<\/strong>/.test(plan.content), plan.content);
  const planStyle = await estilo('.msg-a[data-modo="plan"]', ['border-left-style', 'background-color', 'font-family']);
  check('plan se distingue como hoja sin burbuja', planStyle?.['border-left-style'] === 'dotted' && /transparent|rgba\(0, 0, 0, 0\)/.test(planStyle?.['background-color'] || ''), JSON.stringify(planStyle));
  check('plan usa tipografía de lectura', /serif|Palatino|Georgia/i.test(planStyle?.['font-family'] || ''), String(planStyle?.['font-family']));
  check('el mensaje de usuario conserva la marca de margen', (await pseudo('.msg-user[data-modo="plan"]', '::before', 'content')).includes('›'));
  await page.screenshot({ path: 'tools/shots/modo-plan.png' });

  await sembrarTurno('revisar');
  const ribbonReview = await page.locator('.modo-cinta').textContent();
  check('revisar explica la aprobación en su cinta', /revisar · cada escritura espera tu sí/.test(ribbonReview || ''), ribbonReview || '');
  await page.evaluate(() => window.__aegisWeb.toolFeed({
    toolCallId: 'modo-write-review', kind: 'running', status: 'pending', rawInput: { path: 'src/a.ts', content: 'nuevo' },
    _meta: { aegis: { toolCall: { toolName: 'developer__write' } } },
  }));
  check('metadata ACP prevalece sobre kind=running y marca espera de escritura', await page.locator('.tool.espera[data-tool-name="developer__write"]').count() === 1);
  const reviewStyle = await estilo('.msg-a[data-modo="revisar"]', ['border-top-color']);
  check('revisar muestra el folio ámbar', /217, 164, 91/.test(reviewStyle?.['border-top-color'] || ''), JSON.stringify(reviewStyle));
  check('el folio muestra doblez', /gradient/.test(await pseudo('.msg-a[data-modo="revisar"]', '::after', 'background-image')));
  check('la escritura pendiente dice que espera aprobación', /esperando tu s/.test(await pseudo('.tool.espera .tool-title', '::after', 'content')));
  check('la espera de revisión tiene animación', (await estilo('.tool.espera', ['animation-name']))?.['animation-name'] === 'espera');
  await page.screenshot({ path: 'tools/shots/modo-revisar.png' });

  await sembrarTurno('ejecutar');
  const ribbonExecute = await page.locator('.modo-cinta').textContent();
  check('ejecutar identifica permission.yaml', /ejecutar · permission\.yaml manda/.test(ribbonExecute || ''), ribbonExecute || '');
  await page.evaluate(() => window.__aegisWeb.toolFeed({
    toolCallId: 'modo-write-execute', kind: 'running', status: 'pending', rawInput: { path: 'src/a.ts', content: 'nuevo' },
    _meta: { aegis: { toolCall: { toolName: 'developer__write' } } },
  }));
  check('ejecutar no muestra la marca de aprobación', await page.locator('.tool[data-tool-call-id="modo-write-execute"].espera').count() === 0);
  const execStyle = await estilo('.tool[data-modo="ejecutar"]', ['font-family']);
  check('ejecutar presenta recibos monoespaciados', /mono|Consolas|Cascadia/i.test(execStyle?.['font-family'] || ''), String(execStyle?.['font-family']));
  const execMessageStyle = await estilo('.msg-a[data-modo="ejecutar"]', ['border-left-color']);
  check('ejecutar conserva el acento verde', /143, 192, 164/.test(execMessageStyle?.['border-left-color'] || ''), JSON.stringify(execMessageStyle));
  await page.screenshot({ path: 'tools/shots/modo-ejecutar.png' });

  await page.evaluate(() => window.__aegisWeb.chips.setModo('plan'));
  const labels = await page.evaluate(() => ({
    currentMode: document.getElementById('messages').dataset.modo,
    previousMessageMode: document.querySelector('.msg-a')?.dataset.modo || '',
  }));
  check('al cambiar modo conserva la etiqueta histórica de mensajes', labels.currentMode === 'plan' && labels.previousMessageMode === 'ejecutar', JSON.stringify(labels));
} finally {
  await context.close();
  await browser.close();
}

const passed = results.filter((result) => result.ok).length;
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? `  [${result.detail}]` : ''}`);
if (errors.length) console.log('\nErrores de consola:\n' + errors.join('\n'));
console.log(`\n${passed}/${results.length} PASS`);
process.exit(passed === results.length && !errors.length ? 0 : 1);
