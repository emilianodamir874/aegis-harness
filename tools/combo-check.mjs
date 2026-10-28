// Gate del combobox de chips: abre cada panel con Playwright, escribe, elige con Enter y
// confirma contra el motor (session/load) que el cambio quedo escrito. Escritorio 1440x900 y
// Samsung Galaxy A56 (384x832, DPR 2,8125).
//
// Uso: node tools/combo-check.mjs [http://127.0.0.1:3790/]
// Crea una sesion de descarte en el motor y la borra al final.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:3790/';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));

const PERFILES = {
  escritorio: { nombre: 'Escritorio', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  a56: {
    nombre: 'Samsung Galaxy A56 5G',
    viewport: { width: 384, height: 832 },
    deviceScaleFactor: 2.8125,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-A566B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  },
};

// ---- ACP minimo, para crear/leer/borrar la sesion de descarte ----
class Engine {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pend = new Map();
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && m.method === undefined && this.pend.has(m.id)) {
        this.pend.get(m.id)(m);
        this.pend.delete(m.id);
      }
    });
  }
  async open() {
    await new Promise((res) => this.ws.addEventListener('open', res));
    await this.req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'combo-gate', version: '1' } });
  }
  req(method, params) {
    return new Promise((res) => {
      const id = ++this.id;
      this.pend.set(id, res);
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }));
    });
  }
  async opciones(sessionId) {
    const r = await this.req('session/load', { sessionId, cwd: cfg.cwd, mcpServers: [] });
    const co = (r.result && r.result.configOptions) || [];
    const val = (id) => {
      const o = co.find((x) => x && x.id === id);
      return o ? String(o.currentValue) : null;
    };
    return {
      provider: val('provider'),
      model: val('model'),
      effort: val('thinking_effort'),
      mode: (r.result && r.result.modes && r.result.modes.currentModeId) || val('mode'),
    };
  }
}

const resultados = [];
const check = (nombre, ok, detalle = '') => resultados.push({ nombre, ok: !!ok, detalle });
const errores = [];

const engine = new Engine(`ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`);
await engine.open();
const nueva = await engine.req('session/new', { cwd: cfg.cwd, mcpServers: [] });
const sid = nueva.result && nueva.result.sessionId;
if (!sid) throw new Error('no pude crear la sesion de descarte: ' + JSON.stringify(nueva).slice(0, 200));
console.log('sesion de descarte:', sid);

const browser = await chromium.launch();

// ---------- escritorio ----------
{
  const p = PERFILES.escritorio;
  const ctx = await browser.newContext({ viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errores.push('escritorio pageerror: ' + String(e).slice(0, 140)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push('escritorio console: ' + m.text().slice(0, 140)); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__aegisWeb && !!window.__aegisWeb.chips, null, { timeout: 15000 });
  await page.evaluate((entry) => window.__aegisWeb.chips.abrirSesion(entry), { sessionId: sid, title: 'gate combo', cwd: cfg.cwd });
  await page.waitForSelector('#chips .chip-model', { timeout: 15000 });
  await page.waitForTimeout(600);

  const chips = await page.evaluate(() => ({
    prov: document.querySelector('#chips .chip-prov .chip-t')?.textContent || '',
    modo: document.querySelector('#chips .chip-mode .chip-t')?.textContent || '',
    modelo: document.querySelector('#chips .chip-model .chip-t')?.textContent || '',
    eff: document.querySelector('#chips .chip-model .chip-eff')?.textContent || '',
  }));
  console.log('chips:', JSON.stringify(chips));
  check('hay chip de proveedor', !!chips.prov, chips.prov);
  check('hay chip de modo', !!chips.modo, chips.modo);
  check('hay chip de modelo', !!chips.modelo, chips.modelo);

  // 1) abrir el panel de modelo
  await page.click('#chips .chip-model');
  await page.waitForSelector('.combo-panel', { timeout: 4000 });
  const geo = await page.evaluate(() => {
    const panel = document.querySelector('.combo-panel').getBoundingClientRect();
    const input = document.querySelector('.combo-input');
    const filas = [...document.querySelectorAll('.combo-opt')];
    const secciones = [...document.querySelectorAll('.combo-sec span')].map((s) => s.textContent.trim());
    return {
      top: Math.round(panel.top), left: Math.round(panel.left), w: Math.round(panel.width), h: Math.round(panel.height),
      dentro: panel.top >= 0 && panel.left >= 0 && panel.right <= innerWidth + 1 && panel.bottom <= innerHeight + 1,
      foco: document.activeElement === input,
      filas: filas.length,
      secciones: secciones.slice(0, 6),
      conContexto: filas.filter((f) => /contexto|Mtok/.test(f.querySelector('.co-l2')?.textContent || '')).length,
      activa: document.querySelector('.combo-opt.act .co-name')?.textContent || '',
      aria: document.querySelector('.combo-input')?.getAttribute('aria-expanded'),
    };
  });
  console.log('panel modelo:', JSON.stringify(geo));
  check('panel dentro del viewport', geo.dentro, `${geo.w}x${geo.h} @ ${geo.left},${geo.top}`);
  check('ancho de popover ~380', geo.w >= 340 && geo.w <= 390, String(geo.w));
  check('el foco entra al buscador con teclado/mouse', geo.foco);
  check('filas con segunda linea (contexto/tarifa)', geo.conContexto >= 2, String(geo.conContexto));
  check('el modelo actual viene marcado', !!geo.activa, geo.activa);
  check('la fila activa arranca en el actual', geo.activa.length > 0);
  await page.screenshot({ path: 'tools/shots/combo-escritorio-abierto.png' });

  // 2) buscar "deep" y elegir con Enter
  await page.keyboard.type('deep', { delay: 40 });
  await page.waitForTimeout(200);
  const filtrado = await page.evaluate(() => {
    const filas = [...document.querySelectorAll('.combo-opt')];
    const textos = filas.map((f) => (f.querySelector('.co-name')?.textContent || '').toLowerCase());
    const completo = filas.map((f) => ((f.querySelector('.co-name')?.textContent || '') + ' ' + (f.querySelector('.co-l2')?.textContent || '')).toLowerCase());
    return { n: filas.length, textos, todos: completo.every((t) => t.includes('deep')), contador: document.querySelector('.combo-count')?.textContent || '' };
  });
  console.log('filtro deep:', JSON.stringify(filtrado));
  check('el filtro reduce a modelos deep', filtrado.n > 0 && filtrado.todos, filtrado.textos.join(', '));
  check('el contador dice cuantos de cuantos', /\d+ de \d+/.test(filtrado.contador), filtrado.contador);
  await page.screenshot({ path: 'tools/shots/combo-escritorio-filtro.png' });
  const elegido = filtrado.textos[0];
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const tras = await page.evaluate(() => ({
    panel: !!document.querySelector('.combo-panel'),
    chip: document.querySelector('#chips .chip-model .chip-t')?.textContent || '',
    modelo: window.__aegisWeb.chips.modeloActivo(),
  }));
  console.log('tras Enter:', JSON.stringify(tras));
  check('el panel se cierra al elegir', !tras.panel);
  check('el chip muestra el modelo elegido', tras.chip.toLowerCase().includes('deep'), tras.chip);
  const motor1 = await engine.opciones(sid);
  check('el motor confirma el modelo', (motor1.model || '').toLowerCase().includes('deep'), JSON.stringify(motor1));

  // 3) flechas: bajar dos filas y elegir
  await page.click('#chips .chip-model');
  await page.waitForSelector('.combo-panel');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const activaTeclado = await page.evaluate(() => ({
    activa: document.querySelector('.combo-opt.act .co-name')?.textContent || '',
    aria: document.querySelector('.combo-input')?.getAttribute('aria-activedescendant') || '',
  }));
  check('las flechas mueven la fila activa', !!activaTeclado.activa && !!activaTeclado.aria, activaTeclado.activa);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const trasEsc = await page.evaluate(() => ({
    panel: !!document.querySelector('.combo-panel'),
    expandido: document.querySelector('#chips .chip-model')?.getAttribute('aria-expanded'),
    focoChip: document.activeElement?.classList.contains('chip-model') || false,
  }));
  check('Esc cierra y devuelve el foco al chip', !trasEsc.panel && trasEsc.expandido === 'false', JSON.stringify(trasEsc));

  // 4) sin resultados
  await page.click('#chips .chip-model');
  await page.waitForSelector('.combo-panel');
  await page.keyboard.type('zzzz', { delay: 30 });
  const vacio = await page.evaluate(() => document.querySelector('.combo-empty')?.textContent || '');
  check('avisa cuando no hay resultados', vacio.length > 8, vacio.slice(0, 60));
  await page.screenshot({ path: 'tools/shots/combo-escritorio-vacio.png' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 5) proveedor
  await page.click('#chips .chip-prov');
  await page.waitForSelector('.combo-panel');
  await page.keyboard.type('codex', { delay: 30 });
  const provOpc = await page.evaluate(() => document.querySelector('.combo-opt.act .co-name')?.textContent || '');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1400);
  const chipProv = await page.evaluate(() => document.querySelector('#chips .chip-prov .chip-t')?.textContent || '');
  const motor2 = await engine.opciones(sid);
  check('el proveedor se cambia y el motor lo confirma', /codex/i.test(chipProv) && /codex/i.test(motor2.provider || ''), `${chipProv} / ${motor2.provider}`);
  check('al cambiar de proveedor el modelo se ajusta al suyo', !!motor2.model, JSON.stringify(motor2));

  // 6) modo
  await page.click('#chips .chip-mode');
  await page.waitForSelector('.combo-panel');
  const modoOpc = await page.evaluate(() => [...document.querySelectorAll('.combo-opt .co-name')].map((n) => n.textContent.trim()));
  check('el modo lista las opciones del motor con descripcion', modoOpc.length >= 3, modoOpc.join(', '));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const motor3 = await engine.opciones(sid);
  const chipModo = await page.evaluate(() => document.querySelector('#chips .chip-mode .chip-t')?.textContent || '');
  check('el modo se escribe con session/set_mode', !!motor3.mode && chipModo.toLowerCase() === String(motor3.mode).toLowerCase(), `${chipModo} / ${motor3.mode}`);

  // 7) esfuerzo desde la fila del modelo (tecla →)
  await page.click('#chips .chip-model');
  await page.waitForSelector('.combo-panel');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => (document.querySelector('.combo-panel .combo-title')?.textContent || '').includes('Esfuerzo'), null, { timeout: 4000 });
  const niveles = await page.evaluate(() => [...document.querySelectorAll('.combo-opt .co-name')].map((n) => n.textContent.trim()));
  check('→ abre el esfuerzo de esa fila', niveles.length >= 3, niveles.join(', '));
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const motor4 = await engine.opciones(sid);
  const effChip = await page.evaluate(() => document.querySelector('#chips .chip-model .chip-eff')?.textContent || '');
  check('el esfuerzo se aplica y queda en el chip', motor4.effort === 'off' && /sin razonamiento/i.test(effChip), `${effChip} / ${motor4.effort}`);

  await page.screenshot({ path: 'tools/shots/combo-escritorio-chips.png' });
  await ctx.close();
}

// ---------- movil A56 ----------
{
  const p = PERFILES.a56;
  const ctx = await browser.newContext({
    viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor, isMobile: p.isMobile, hasTouch: p.hasTouch, userAgent: p.userAgent,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errores.push('a56 pageerror: ' + String(e).slice(0, 140)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push('a56 console: ' + m.text().slice(0, 140)); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__aegisWeb && !!window.__aegisWeb.chips, null, { timeout: 15000 });
  // esperar el catalogo: sin sesion, los chips salen del catalogo
  await page.waitForFunction(() => !!window.__aegisWeb.chips.catalogo(), null, { timeout: 20000 });
  await page.waitForSelector('#chips .chip-model', { timeout: 8000 });
  await page.waitForTimeout(400);

  await page.tap('#chips .chip-model');
  await page.waitForSelector('.combo-root.is-sheet .combo-panel', { timeout: 4000 });
  await page.waitForTimeout(350); // la hoja entra con una animacion de 200 ms: medirla quieta
  const hoja = await page.evaluate(() => {
    const panel = document.querySelector('.combo-panel').getBoundingClientRect();
    const fila = document.querySelector('.combo-opt').getBoundingClientRect();
    return {
      esHoja: !!document.querySelector('.combo-root.is-sheet'),
      abajo: panel.bottom <= innerHeight + 1 && panel.top >= 0,
      ancho: Math.round(panel.width), alto: Math.round(panel.height),
      filaAlto: Math.round(fila.height),
      focoInput: document.activeElement?.classList.contains('combo-input') || false,
      telon: !!document.querySelector('.combo-root.is-sheet .combo-back'),
    };
  });
  console.log('hoja movil:', JSON.stringify(hoja));
  check('en el telefono se abre como hoja inferior', hoja.esHoja && hoja.abajo, `${hoja.ancho}x${hoja.alto}`);
  check('la hoja ocupa todo el ancho', hoja.ancho >= 382, String(hoja.ancho));
  check('filas de 48 px o mas', hoja.filaAlto >= 48, String(hoja.filaAlto));
  check('no roba el foco al abrir (el teclado espera)', !hoja.focoInput);
  check('hay telon detras de la hoja', hoja.telon);
  await page.screenshot({ path: 'tools/shots/combo-movil-hoja.png' });

  await page.tap('.combo-input');
  await page.keyboard.type('flash', { delay: 40 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'tools/shots/combo-movil-filtro.png' });
  const filtro = await page.evaluate(() => [...document.querySelectorAll('.combo-opt')].map((f) => ((f.querySelector('.co-name')?.textContent || '') + ' ' + (f.querySelector('.co-l2')?.textContent || '')).toLowerCase()));
  check('la busqueda funciona en el telefono', filtro.length > 0 && filtro.every((t) => t.includes('flash')) && filtro[0].includes('flash'), `${filtro.length} filas, primera: ${filtro[0]}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const despues = await page.evaluate(() => ({
    panel: !!document.querySelector('.combo-panel'),
    chip: document.querySelector('#chips .chip-model .chip-t')?.textContent || '',
    pendiente: window.__aegisWeb.chips.modeloActivo(),
  }));
  check('elegir en el telefono cierra la hoja y actualiza el chip', !despues.panel && /flash/i.test(despues.chip), JSON.stringify(despues));
  await page.screenshot({ path: 'tools/shots/combo-movil-chip.png' });
  await ctx.close();
}

await browser.close();
await engine.req('session/delete', { sessionId: sid });
engine.ws.close();

const ok = resultados.filter((r) => r.ok).length;
for (const r of resultados) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.nombre}${r.detalle ? '  [' + r.detalle + ']' : ''}`);
if (errores.length) console.log('\nerrores de consola:\n' + errores.join('\n'));
console.log(`\n${ok}/${resultados.length} PASS`);
process.exit(ok === resultados.length && !errores.length ? 0 : 1);
