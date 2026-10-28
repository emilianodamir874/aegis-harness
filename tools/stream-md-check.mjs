// Gate del markdown en vivo: pide una respuesta con tabla y lista y comprueba que el formato
// aparece DURANTE el turno (sin recargar y sin esperar a que cierre), que el texto crudo con
// pipes no queda a la vista, y que el scroll sigue abajo si el usuario estaba abajo.
//
// Uso: node tools/stream-md-check.mjs [http://192.168.100.34:3788/]
// Crea una sesion de descarte, le pide una respuesta corta al motor real y la borra al final.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://192.168.100.34:3788/';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const PERFIL = process.argv[3] === 'a56'
  ? { nombre: 'A56', viewport: { width: 384, height: 832 }, deviceScaleFactor: 2.8125, isMobile: true, hasTouch: true }
  : { nombre: 'Escritorio', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

const ws = new WebSocket(`ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`);
let id = 0;
const pend = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && !m.method && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res) => {
  const mid = ++id;
  pend.set(mid, res);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params: params || {} }));
});
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'md-gate', version: '1' } });
const ns = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
const sid = ns.result.sessionId;
// Sin razonamiento: lo que se prueba es el pintado del markdown, no el pensamiento del modelo.
await req('session/set_config_option', { sessionId: sid, configId: 'thinking_effort', value: 'off' });
await req('session/set_config_option', { sessionId: sid, configId: 'model', value: 'deepseek-v4.1-flash' });
console.log('sesion de descarte:', sid, '| perfil:', PERFIL.nombre);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: PERFIL.viewport, deviceScaleFactor: PERFIL.deviceScaleFactor,
  isMobile: PERFIL.isMobile || false, hasTouch: PERFIL.hasTouch || false,
});
const page = await ctx.newPage();
const errores = [];
page.on('pageerror', (e) => errores.push(String(e).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|403/.test(m.text())) errores.push(m.text().slice(0, 160)); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__aegisWeb?.chips, null, { timeout: 15000 });
await page.evaluate((entry) => window.__aegisWeb.chips.abrirSesion(entry), { sessionId: sid, title: 'gate md', cwd: cfg.cwd });
await page.waitForSelector('#input', { timeout: 15000 });
await page.waitForTimeout(800);

const prompt = 'Respondé SOLO esto, sin explicaciones: una tabla markdown de 3 filas con columnas Nombre|Valor (inventá los valores) y debajo una lista de 3 items. Nada mas.';
await page.click('#input');
await page.keyboard.type(prompt, { delay: 4 });
await page.keyboard.press('Enter');

// Muestreo durante el turno: nos interesa lo que pasa MIENTRAS el mensaje sigue creciendo.
const muestras = [];
const t0 = Date.now();
let cerro = false;
while (Date.now() - t0 < 120000) {
  const s = await page.evaluate(() => {
    const caja = document.querySelector('#messages');
    // La respuesta es la caja de contenido que NO es razonamiento: el pensamiento tambien
    // lleva .streaming y no tiene tablas, asi que si se mezclan el gate mide la caja equivocada.
    const vivas = [...document.querySelectorAll('#msg-inner .msg-a.streaming')].filter((el) => !el.querySelector('.thought'));
    const vivo = vivas[vivas.length - 1] || null;
    const cuerpo = vivo || document.querySelector('#msg-inner');
    const texto = cuerpo ? cuerpo.textContent || '' : '';
    return {
      streaming: !!vivo,
      tabla: !!document.querySelector('#msg-inner .msg-a:not(:has(.thought)) table'),
      lista: !!document.querySelector('#msg-inner .msg-a:not(:has(.thought)) ul, #msg-inner .msg-a:not(:has(.thought)) ol'),
      crudoPipes: /(^|\n)\s*\|[^\n]*\|/.test(texto),
      chars: texto.length,
      abajo: caja ? Math.abs(caja.scrollHeight - caja.clientHeight - caja.scrollTop) < 8 : null,
    };
  });
  muestras.push({ t: Date.now() - t0, ...s });
  // Cierra el bucle cuando el turno deja de estar vivo (despues de haberlo estado).
  if (!s.streaming && muestras.some((m) => m.streaming)) { cerro = true; break; }
  await page.waitForTimeout(140);
}
const curva = muestras.filter((m, i) => i % 12 === 0).map((m) => `${m.t}ms:${m.chars}c${m.tabla ? '+tabla' : ''}${m.lista ? '+lista' : ''}`).join(' ');

const durante = muestras.filter((m) => m.streaming);
const tablaEnVivo = durante.find((m) => m.tabla);
const listaEnVivo = durante.find((m) => m.lista);
const crudoEnVivo = durante.filter((m) => m.crudoPipes);
const abajoDurante = durante.every((m) => m.abajo !== false);

const final = await page.evaluate(() => ({
  tabla: !!document.querySelector('#msg-inner .msg-a table'),
  filas: document.querySelectorAll('#msg-inner .msg-a table tbody tr').length,
  lista: document.querySelectorAll('#msg-inner .msg-a li').length,
  streaming: !!document.querySelector('.msg-a.streaming'),
}));

const filas = [
  ['la respuesta llega a cerrar el turno', cerro, `${muestras.length} muestras`],
  ['hay tabla formateada DURANTE el stream', !!tablaEnVivo, tablaEnVivo ? `a los ${tablaEnVivo.t} ms, ${tablaEnVivo.chars} chars` : 'nunca'],
  ['hay lista formateada DURANTE el stream', !!listaEnVivo, listaEnVivo ? `a los ${listaEnVivo.t} ms` : 'nunca'],
  ['nunca se ve la tabla como pipes crudos', crudoEnVivo.length === 0, crudoEnVivo.length ? `${crudoEnVivo.length} muestras` : ''],
  ['el scroll se queda abajo mientras crece', abajoDurante, ''],
  ['al cerrar queda tabla con filas y lista', final.tabla && final.filas >= 3 && final.lista >= 3, `filas ${final.filas}, items ${final.lista}`],
  ['sin errores de consola', errores.length === 0, errores.join(' | ')],
];
console.log('curva:', curva.slice(0, 600));
console.log('ultimas 3:', JSON.stringify(muestras.slice(-3)));
for (const [n, ok, d] of filas) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  [' + d + ']' : ''}`);
await page.screenshot({ path: `tools/shots/markdown-vivo-${PERFIL.nombre.toLowerCase()}.png` });
const ok = filas.every((f) => f[1]);
await browser.close();
await req('session/delete', { sessionId: sid });
ws.close();
console.log(`\n${filas.filter((f) => f[1]).length}/${filas.length} PASS`);
process.exit(ok ? 0 : 1);
