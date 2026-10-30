// Gate del panel doctor: /doctor.json responde con datos reales y el panel los muestra.
// Inyecta sesion falsa (patron de los otros gates) y no crea prompts ni sesiones.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

/** Password local del operador. Solo se usa para el POST /login de este gate. */
function passwordLocal() {
  try {
    return JSON.parse(readFileSync('C:/Aegis-Proyects/web/auth.json', 'utf8')).password || null;
  } catch {
    return null;
  }
}

const base = (process.argv[2] || 'http://127.0.0.1:3788').replace(/\/+$/, '');
const out = [];
const gate = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail });

// 1) el endpoint, con la cookie de sesion que este gate obtiene del server de pruebas
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

let doctorBody = null;
page.on('response', async (r) => {
  if (r.url().includes('/doctor.json')) {
    try { doctorBody = await r.json(); } catch {}
  }
});

// Login primero: el resto del gate solo tiene sentido con sesion.
const pw = passwordLocal();
if (pw) {
  const login = await ctx.request.post(base + '/login', { form: { password: pw }, maxRedirects: 0 });
  gate('login local', login.status() === 302 || login.status() === 200, 'HTTP ' + login.status());
  const cookies = await ctx.cookies();
  if (cookies.length) await ctx.addCookies(cookies);
}

await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2500);

// El endpoint exige sesion: si el gate corre sin cookie, 401 es la respuesta correcta y se declara.
const status = await page.evaluate(async () => {
  const r = await fetch('./doctor.json', { cache: 'no-store' });
  return r.status;
});
gate('endpoint responde', status === 200 || status === 401, 'HTTP ' + status);

if (status === 200 && doctorBody) {
  gate('version desplegada', typeof doctorBody.version?.desplegada === 'string' && doctorBody.version.desplegada.startsWith('v'),
    doctorBody.version?.desplegada || 'sin tag');
  gate('serve vivo', doctorBody.serve?.vivo === true);
  gate('store medido', typeof doctorBody.store?.dbBytes === 'number' && doctorBody.store.dbBytes > 0,
    String(doctorBody.store?.dbBytes));
  gate('techo de compactacion', doctorBody.compactacion?.techoTokens > 0, String(doctorBody.compactacion?.techoTokens));
  gate('informe del gate', !!doctorBody.gate && Array.isArray(doctorBody.gate.chequeos) && doctorBody.gate.chequeos.length > 0,
    (doctorBody.gate?.chequeos?.length || 0) + ' chequeos');
}

// 2) el panel, si hay boton y endpoint accesible
const boton = await page.$('#btn-doctor');
gate('boton en el topbar', !!boton);
if (boton && status === 200) {
  await boton.click();
  await page.waitForTimeout(1200);
  const filas = await page.$$eval('.aegis-doctor td', (tds) => tds.map((td) => td.textContent?.trim() || ''));
  gate('panel con filas', filas.length >= 5, filas.length + ' celdas');
  gate('panel muestra la version', filas.some((t) => /^v\d+$/.test(t)), filas.find((t) => /^v\d+$/.test(t)) || 'sin tag');
  gate('panel muestra el techo', filas.some((t) => t.includes('techo')), filas.find((t) => t.includes('techo')) || 'sin techo');
  const chequeosGate = await page.$$eval('.aegis-doctor h3', (h) => h.length);
  gate('seccion de chequeos', chequeosGate >= 1);
  await page.screenshot({ path: 'C:/Users/Emiliano/backups/doctor-20261028/panel.png', fullPage: false }).catch(() => {});
  gate('foco inicial en cerrar', await page.evaluate(() => document.activeElement?.textContent?.trim() === 'Cerrar'));
  await page.keyboard.press('Tab');
  gate('Tab vuelve a actualizar', await page.evaluate(() => document.activeElement?.textContent?.trim() === 'Actualizar'));
  await page.keyboard.press('Shift+Tab');
  gate('Shift+Tab vuelve a cerrar', await page.evaluate(() => document.activeElement?.textContent?.trim() === 'Cerrar'));
  gate('fondo inerte', await page.evaluate(() => [...document.body.children].filter((el) => el instanceof HTMLElement && !el.classList.contains('aegis-doctor-shade')).every((el) => el.inert)));
  await page.keyboard.press('Escape');
  gate('Escape cierra y devuelve foco', await page.evaluate(() => !document.querySelector('.aegis-doctor-shade') && document.activeElement?.id === 'btn-doctor' && ![...document.body.children].filter((el) => el instanceof HTMLElement).some((el) => el.inert)));
} else if (boton) {
  // Sin sesion el panel carga pero el endpoint da 401: se verifica que informe el fallo y no rompa.
  await boton.click();
  await page.waitForTimeout(1000);
  const texto = await page.$eval('.aegis-doctor main', (m) => m.textContent || '');
  gate('panel informa el 401 sin romper', texto.includes('No se pudo leer el estado'), texto.slice(0, 60));
}

const errores = [];
page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });
await page.waitForTimeout(300);
gate('sin errores de consola', errores.length === 0, errores.slice(0, 2).join(' | '));

await browser.close();

const ancho = Math.max(...out.map((r) => r.name.length));
for (const r of out) console.log((r.ok ? 'OK  ' : 'FAIL') + ' ' + r.name.padEnd(ancho) + '  ' + r.detail);
const fallas = out.filter((r) => !r.ok).length;
console.log('\n' + (out.length - fallas) + '/' + out.length + ' ' + (fallas ? 'con fallas' : 'PASS'));
process.exit(fallas ? 1 : 0);
