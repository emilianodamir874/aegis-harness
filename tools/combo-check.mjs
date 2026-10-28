// Gate del asistente de modelo: proveedor -> modelo -> esfuerzo, con motor real.
// Uso: node tools/combo-check.mjs [url]
// Crea una sesion de descarte y la borra al final.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://192.168.100.34:3788/';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const PERFILES = {
  escritorio: { nombre: 'Escritorio', viewport: { width: 1440, height: 900 }, dpr: 1 },
  a56: {
    nombre: 'Samsung Galaxy A56 5G', viewport: { width: 384, height: 832 }, dpr: 2.8125,
    isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-A566B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  },
};

const ws = new WebSocket(`ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`);
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && !m.method && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: m, params: p || {} })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'pasos', version: '1' } });
const sid = (await req('session/new', { cwd: cfg.cwd, mcpServers: [] })).result.sessionId;

const motor = async () => {
  const r = await req('session/load', { sessionId: sid, cwd: cfg.cwd, mcpServers: [] });
  const co = r.result.configOptions || [];
  const v = (k) => { const o = co.find((x) => x && x.id === k); return o ? String(o.currentValue) : ''; };
  return { provider: v('provider'), model: v('model'), effort: v('thinking_effort'), mode: (r.result.modes || {}).currentModeId };
};

const res = [];
const check = (n, ok, d = '') => res.push({ n, ok: !!ok, d });
const errores = [];
const browser = await chromium.launch();

/** Estado del panel de pasos. */
const panel = (page) => page.evaluate(() => {
  const p = document.querySelector('.combo-panel');
  if (!p) return null;
  return {
    titulo: p.querySelector('.combo-title')?.textContent || '',
    secciones: [...p.querySelectorAll('.combo-sec span')].map((x) => x.textContent.trim()),
    miga: p.querySelector('.combo-crumb')?.textContent || '',
    atras: !p.querySelector('.combo-back-go')?.hidden,
    filas: [...p.querySelectorAll('.combo-opt .co-name')].map((n) => n.textContent.trim()),
    vacio: p.querySelector('.combo-empty')?.textContent || '',
    foco: document.activeElement?.classList.contains('combo-input') || false,
    hoja: !!document.querySelector('.combo-root.is-sheet'),
  };
});

async function conPagina(perfil, fn) {
  const ctx = await browser.newContext({
    viewport: perfil.viewport, deviceScaleFactor: perfil.dpr,
    isMobile: !!perfil.isMobile, hasTouch: !!perfil.hasTouch, userAgent: perfil.userAgent,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errores.push(String(e).slice(0, 140)));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|403/.test(m.text())) errores.push(m.text().slice(0, 140)); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__aegisWeb?.chips, null, { timeout: 15000 });
  await page.evaluate((e) => window.__aegisWeb.chips.abrirSesion(e), { sessionId: sid, title: 'gate pasos', cwd: cfg.cwd });
  await page.waitForSelector('#chips .chip-model', { timeout: 15000 });
  await page.waitForTimeout(900);
  await fn(page);
  await ctx.close();
}

// ---------- escritorio ----------
await conPagina(PERFILES.escritorio, async (page) => {
  const chip = await page.evaluate(() => ({
    sub: document.querySelector('#chips .chip-sub')?.textContent || '',
    t: document.querySelector('#chips .chip-t')?.textContent || '',
    provSuelto: !!document.querySelector('#chips .chip-prov'),
  }));
  check('chip unico: proveedor + modelo, sin chip de proveedor', !chip.provSuelto && !!chip.sub && !!chip.t, `${chip.sub} / ${chip.t}`);

  // Paso 1: proveedores
  await page.click('#chips .chip-model');
  await page.waitForSelector('.combo-panel');
  const p1 = await panel(page);
  check('paso 1 se titula Proveedor', p1.titulo === 'Proveedor', p1.titulo);
  check('paso 1 no muestra el boton atras', !p1.atras);
  check('paso 1 lista los proveedores arriba y los modelos abajo', p1.filas.length >= 3 && p1.filas.some((f) => /Codex|Design|Antigravity/i.test(f)) && p1.secciones.includes('Proveedor') && p1.secciones.includes('Modelos'), `${p1.filas.length} filas, secciones: ${p1.secciones.join(' / ')}`);
  check('el buscador arranca con el foco', p1.foco);
  await page.screenshot({ path: 'tools/shots/pasos-1-proveedor.png' });

  // Paso 2: filtra proveedor y entra a sus modelos
  await page.keyboard.type('codex', { delay: 30 });
  const filtrado = await page.evaluate(() => [...document.querySelectorAll('.combo-opt .co-name')].map((n) => n.textContent.trim()));
  check('tipear un proveedor lo deja primero y suma sus modelos', /^ChatGPT Codex$/i.test(filtrado[0] || '') && filtrado.length > 1, `${filtrado.length} filas, primera: ${filtrado[0]}`);
  await page.screenshot({ path: 'tools/shots/pasos-2-proveedor-filtrado.png' });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const p2 = await panel(page);
  check('paso 2 se titula Modelo', p2.titulo === 'Modelo', p2.titulo);
  check('paso 2 muestra la miga del proveedor', /codex/i.test(p2.miga), p2.miga);
  check('paso 2 ofrece volver', p2.atras);
  check('paso 2 lista los modelos de ESE proveedor', p2.filas.length > 0 && p2.filas.some((f) => /gpt/i.test(f)), `${p2.filas.length} modelos`);
  check('al entrar al paso 2 el buscador esta limpio y con foco', p2.foco);
  await page.screenshot({ path: 'tools/shots/pasos-2-modelos.png' });

  // Atras con el boton y con la flecha izquierda
  await page.click('.combo-back-go');
  await page.waitForTimeout(200);
  const volvio = await panel(page);
  check('el boton atras vuelve al paso 1', volvio.titulo === 'Proveedor', volvio.titulo);
  await page.keyboard.type('codex', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  const volvio2 = await panel(page);
  check('← vuelve un paso', volvio2.titulo === 'Proveedor', volvio2.titulo);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // Flujo completo: elegir proveedor, modelo y esfuerzo
  await page.click('#chips .chip-model');
  await page.waitForSelector('.combo-panel');
  await page.keyboard.type('codex', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const enModelo = await panel(page);
  const modeloElegido = enModelo.filas[0] || '';
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const p3 = await panel(page);
  check('paso 3 se titula Esfuerzo', p3.titulo === 'Esfuerzo', p3.titulo);
  check('paso 3 lista los niveles', p3.filas.length >= 3, p3.filas.join(', '));
  check('paso 3 recuerda proveedor y modelo en la miga', /codex/i.test(p3.miga) && p3.miga.includes('\u203a') && p3.miga.length > 'ChatGPT Codex \u203a'.length, p3.miga);
  await page.screenshot({ path: 'tools/shots/pasos-3-esfuerzo.png' });
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const cerrado = await page.evaluate(() => ({
    panel: !!document.querySelector('.combo-panel'),
    sub: document.querySelector('#chips .chip-model .chip-sub')?.textContent || '',
    t: document.querySelector('#chips .chip-model .chip-t')?.textContent || '',
    eff: document.querySelector('#chips .chip-model .chip-eff')?.textContent || '',
  }));
  const m1 = await motor();
  check('el flujo de tres pasos aplica proveedor+modelo+esfuerzo', !cerrado.panel && /codex/i.test(cerrado.sub) && !!modeloElegido && cerrado.t.toLowerCase() === modeloElegido.toLowerCase() && m1.provider === 'chatgpt_codex' && !!m1.model, `${cerrado.t} / ${JSON.stringify(m1)}`);
  check('el esfuerzo elegido es el del motor', m1.effort === 'off' && /sin razonamiento/i.test(cerrado.eff), `${cerrado.eff} / ${m1.effort}`);
  await page.screenshot({ path: 'tools/shots/pasos-chip-final.png' });

  // Atajo: tipear un modelo en el paso 1 lo encuentra cruzando proveedores
  await page.click('#chips .chip-model');
  await page.waitForSelector('.combo-panel');
  await page.keyboard.type('flash', { delay: 25 });
  await page.waitForTimeout(300);
  const atajo = await page.evaluate(() => ({
    secciones: [...document.querySelectorAll('.combo-sec span')].map((s) => s.textContent.trim()),
    n: document.querySelectorAll('.combo-opt').length,
  }));
  check('tipear un modelo en el paso 1 lo busca en todos los proveedores', atajo.secciones.includes('Modelos') && atajo.n > 3, `${atajo.n} filas`);
  await page.keyboard.press('Escape');

  // Modo: sigue siendo su propio panel
  await page.click('#chips .chip-mode');
  await page.waitForSelector('.combo-panel');
  const pm = await panel(page);
  check('el chip de modo abre su panel con los modos del motor', pm.titulo === 'Modo' && pm.filas.length >= 3, pm.filas.join(', '));
  await page.keyboard.press('Escape');
});

// ---------- A56: hoja inferior con los mismos pasos ----------
await conPagina(PERFILES.a56, async (page) => {
  await page.tap('#chips .chip-model');
  await page.waitForSelector('.combo-root.is-sheet .combo-panel');
  await page.waitForTimeout(320);
  const p1 = await panel(page);
  check('en el telefono el paso 1 tambien es la lista de proveedores', p1.hoja && p1.titulo === 'Proveedor' && p1.filas.length >= 3, `${p1.titulo}: ${p1.filas.length}`);
  const geo = await page.evaluate(() => {
    const p = document.querySelector('.combo-panel').getBoundingClientRect();
    const f = document.querySelector('.combo-opt').getBoundingClientRect();
    return { abajo: p.bottom <= innerHeight + 1 && p.top >= 0, ancho: Math.round(p.width), fila: Math.round(f.height) };
  });
  check('la hoja queda dentro del viewport con filas de 48 px', geo.abajo && geo.ancho >= 382 && geo.fila >= 48, `${geo.ancho}x fila ${geo.fila}`);
  await page.screenshot({ path: 'tools/shots/pasos-a56-proveedor.png' });
  await page.tap('.combo-input');
  await page.keyboard.type('open design', { delay: 25 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const p2 = await panel(page);
  check('el paso 2 en el telefono mantiene la miga y el atras', p2.titulo === 'Modelo' && p2.miga.length > 3 && p2.atras, `${p2.titulo} · ${p2.miga}`);
  await page.screenshot({ path: 'tools/shots/pasos-a56-modelos.png' });
  await page.keyboard.type('deepseek', { delay: 25 });
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const p3 = await panel(page);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const fin = await page.evaluate(() => ({ panel: !!document.querySelector('.combo-panel'), t: document.querySelector('#chips .chip-model .chip-t')?.textContent || '' }));
  check('en el telefono se recorren los pasos hasta aplicar', !fin.panel && /deepseek/i.test(fin.t), `${p3.titulo} -> ${fin.t}`);
  await page.screenshot({ path: 'tools/shots/pasos-a56-final.png' });
});

await browser.close();
await req('session/delete', { sessionId: sid });
ws.close();

const ok = res.filter((r) => r.ok).length;
for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '  [' + r.d + ']' : ''}`);
if (errores.length) console.log('\nerrores de consola:\n' + errores.join('\n'));
console.log(`\n${ok}/${res.length} PASS`);
process.exit(ok === res.length && !errores.length ? 0 : 1);
