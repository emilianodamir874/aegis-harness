// Gate de los paneles del cromo: letra, uso/gasto, objetivos y estado del chat.
// Mide tipografia por rol (rotulo / valor / cifra), jerarquia, ancho dentro del viewport y que
// el control de letra mueva de verdad la muestra. Usa una sesion REAL con historial para que el
// panel de uso tenga cifras.
// Uso: node tools/paneles-check.mjs [url]
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://192.168.100.34:3788/';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));

const ws = new WebSocket(`ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`);
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && !m.method && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: m, params: p || {} })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'paneles', version: '1' } });

// Sesion con historial: la que mas mensajes tenga.
const lista = await req('session/list', {});
const sesiones = ((lista.result && lista.result.sessions) || []).slice().sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
const real = sesiones.find((s) => (s.messageCount || 0) > 4) || sesiones[0];
if (!real) { console.log('no hay sesiones para medir'); process.exit(1); }
console.log('sesion de prueba:', real.sessionId, '| mensajes:', real.messageCount || 0);

const res = [];
const check = (n, ok, d = '') => res.push({ n, ok: !!ok, d });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errores = [];
page.on('pageerror', (e) => errores.push(String(e).slice(0, 160)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__aegisWeb?.chips, null, { timeout: 15000 });
await page.evaluate((e) => window.__aegisWeb.chips.abrirSesion(e), { sessionId: real.sessionId, title: real.title || 'panel', cwd: real.cwd || cfg.cwd });
await page.waitForSelector('#chips .chip-model', { timeout: 20000 });
await page.waitForTimeout(2500);

const medir = (sel, roles) => page.evaluate(({ sel, roles }) => {
  const root = document.querySelector(sel);
  if (!root) return null;
  const px = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : null);
  const out = { ancho: Math.round(root.getBoundingClientRect().width), alto: Math.round(root.getBoundingClientRect().height), roles: {} };
  for (const [rol, q] of Object.entries(roles)) out.roles[rol] = px(root.querySelector(q));
  const r = root.getBoundingClientRect();
  out.dentro = r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
  out.desborde = root.scrollWidth > root.clientWidth + 1;
  return out;
}, { sel, roles });

// ---------- 1. letra ----------
await page.click('#btn-chat-font');
await page.waitForTimeout(400);
const letra = await medir('#chat-font-pop', { titulo: '.cf-title', valor: '.cf-val', muestra: '#cf-muestra' });
console.log('letra:', JSON.stringify(letra));
check('el panel de letra tiene rotulo, valor y muestra', !!(letra && letra.roles.titulo && letra.roles.valor && letra.roles.muestra), JSON.stringify(letra && letra.roles));
check('la muestra se pinta con el tamano elegido', letra && Math.abs(letra.roles.muestra - 16) < 0.6, `muestra ${letra && letra.roles.muestra} px`);
check('el rotulo es mas chico que el valor (jerarquia)', letra && letra.roles.titulo < letra.roles.valor, `${letra && letra.roles.titulo} < ${letra && letra.roles.valor}`);
check('el panel de letra entra entero en pantalla', letra && letra.dentro && !letra.desborde, `${letra && letra.ancho}x${letra && letra.alto}`);
// el control mueve la muestra
await page.evaluate(() => { const r = document.querySelector('#chat-font-range'); r.value = '22'; r.dispatchEvent(new Event('input', { bubbles: true })); });
await page.waitForTimeout(250);
const crecida = await page.evaluate(() => ({
  muestra: parseFloat(getComputedStyle(document.querySelector('#cf-muestra')).fontSize),
  valor: document.querySelector('#chat-font-value').textContent,
}));
check('subir el control agranda la muestra y el valor', Math.abs(crecida.muestra - 22) < 0.6 && /22/.test(crecida.valor), `${crecida.muestra} px / ${crecida.valor}`);
await page.evaluate(() => document.querySelector('#chat-font-reset').click());
await page.waitForTimeout(200);
await page.keyboard.press('Escape');

// ---------- 2. uso y gasto ----------
await page.evaluate(() => { const a = document.querySelector('#meta-right'); if (a) a.click(); });
await page.waitForTimeout(600);
const uso = await medir('#usage-pop', {
  rotulo: '.up-k', pct: '.up-pct', sub: '.up-sub', gasto: '.up-money-v',
  celdaK: '.up-cell-k', celdaV: '.up-cell-v',
});
console.log('uso:', JSON.stringify(uso));
check('el panel de uso muestra la cifra de gasto', !!(uso && uso.roles.gasto), JSON.stringify(uso && uso.roles));
check('la cifra de gasto es la mas grande del panel', uso && uso.roles.gasto > uso.roles.celdaV && uso.roles.gasto > uso.roles.sub, `${uso && uso.roles.gasto} px`);
check('los rotulos son mas chicos que los valores', uso && uso.roles.celdaK < uso.roles.celdaV && uso.roles.rotulo < uso.roles.pct, `${uso && uso.roles.celdaK} < ${uso && uso.roles.celdaV}`);
const celdas = await page.evaluate(() => [...document.querySelectorAll('#usage-pop .up-cell')].map((c) => c.textContent.trim().replace(/\s+/g, ' ')));
check('hay cuatro metricas con rotulo y glosa', celdas.length === 4, celdas.join(' | '));
check('el panel de uso entra entero en pantalla', uso && uso.dentro && !uso.desborde, `${uso && uso.ancho}x${uso && uso.alto}`);
const dinero = await page.evaluate(() => ({
  v: document.querySelector('#usage-pop .up-money-v').textContent.trim(),
  s: document.querySelector('#usage-pop .up-money-s').textContent.trim(),
}));
console.log('gasto:', JSON.stringify(dinero));
await page.screenshot({ path: 'tools/shots/panel-uso-real.png', clip: await page.evaluate(() => {
  const r = document.querySelector('#usage-pop').getBoundingClientRect();
  return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16 };
}) });
await page.keyboard.press('Escape');
await page.evaluate(() => { const a = document.querySelector('#meta-right'); if (a) a.click(); });
await page.waitForTimeout(200);

// ---------- 3. objetivos ----------
await page.click('#btn-goals');
await page.waitForTimeout(700);
const obj = await page.evaluate(() => {
  const g = document.querySelector('#goals');
  if (!g || g.hidden) return null;
  const r = g.getBoundingClientRect();
  const t = g.textContent.replace(/\s+/g, ' ').trim();
  const cs = getComputedStyle(g);
  return { ancho: Math.round(r.width), alto: Math.round(r.height), texto: t.slice(0, 140), fuente: cs.fontSize, dentro: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 };
});
console.log('objetivos:', JSON.stringify(obj));
check('el panel de objetivos abre y se lee', !!obj && obj.ancho > 200, obj ? `${obj.ancho}x${obj.alto} · ${obj.texto.slice(0, 60)}` : 'no abrio');
check('no muestra un error crudo de sesion', !!obj && !/no encontr|error|undefined/i.test(obj.texto), obj && obj.texto.slice(0, 80));
await page.keyboard.press('Escape');

// ---------- 4. estado del chat ----------
await page.click('#btn-chat-info');
await page.waitForTimeout(500);
const info = await medir('#chat-info', { titulo: '.ci-title', clave: '.ci-k', valor: '.ci-v' });
console.log('info:', JSON.stringify(info));
check('el panel de estado tiene rotulo, claves y valores', !!(info && info.roles.titulo && info.roles.clave && info.roles.valor), JSON.stringify(info && info.roles));
check('las claves son mas chicas que los valores', info && info.roles.clave < info.roles.valor, `${info && info.roles.clave} < ${info && info.roles.valor}`);
await page.keyboard.press('Escape');

// ---------- movil: los cuatro entran enteros ----------
const m = await (await browser.newContext({
  viewport: { width: 384, height: 832 }, deviceScaleFactor: 2.8125, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-A566B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
})).newPage();
await m.goto(BASE, { waitUntil: 'domcontentloaded' });
await m.waitForFunction(() => !!window.__aegisWeb?.chips, null, { timeout: 15000 });
await m.evaluate((e) => window.__aegisWeb.chips.abrirSesion(e), { sessionId: real.sessionId, title: real.title || 'panel', cwd: real.cwd || cfg.cwd });
await m.waitForSelector('#chips .chip-model', { timeout: 20000 });
await m.waitForTimeout(1800);
// En el telefono los botones secundarios viven detras de "mas opciones".
await m.evaluate(() => { const b = document.querySelector('#btn-topbar-more'); if (b) b.click(); });
await m.waitForTimeout(350);
await m.evaluate(() => { const b = document.querySelector('#btn-chat-font'); if (b) b.click(); });
await m.waitForTimeout(450);
const letraM = await m.evaluate(() => {
  const p = document.querySelector('#chat-font-pop');
  const r = p.getBoundingClientRect();
  const btns = [...p.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().height));
  return { ancho: Math.round(r.width), dentro: r.left >= 0 && r.right <= innerWidth + 1, botones: btns };
});
console.log('letra movil:', JSON.stringify(letraM));
check('en el telefono el panel de letra entra y los botones son tactiles', letraM.dentro && letraM.ancho <= 384 && Math.min(...letraM.botones) >= 36, `${letraM.ancho}px · botones ${letraM.botones.join('/')}`);
try {
  await m.screenshot({ path: 'tools/shots/panel-letra-a56.png', clip: await m.evaluate(() => {
    const r = document.querySelector('#chat-font-pop').getBoundingClientRect();
    return { x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), width: r.width + 12, height: r.height + 12 };
  }) });
} catch (e) { console.log('captura movil:', String(e).slice(0, 80)); }

await browser.close();
ws.close();

const ok = res.filter((r) => r.ok).length;
for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '  [' + r.d + ']' : ''}`);
if (errores.length) console.log('\nerrores de consola:\n' + errores.join('\n'));
console.log(`\n${ok}/${res.length} PASS`);
process.exit(ok === res.length && !errores.length ? 0 : 1);
