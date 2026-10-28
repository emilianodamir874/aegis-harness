// Presets de dispositivos para Playwright, con el A56 del operador como default.
// Uso: node tools/mobile-check.mjs http://127.0.0.1:3788/
// Mide lo que importa en el telefono: alto del topbar, filas que ocupa, hueco reservado por
// contenedores vacios, desborde horizontal, ancho real del transcript y errores de consola.
import { chromium } from 'playwright';

export const PERFILES = {
  a56: { nombre: 'Samsung Galaxy A56 5G', viewport: { width: 384, height: 832 }, deviceScaleFactor: 2.8125, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-A566B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' },
  a52: { nombre: 'Samsung Galaxy A52', viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  escritorio: { nombre: 'Escritorio', viewport: { width: 1440, height: 900 } },
};

const url = process.argv[2] || 'http://127.0.0.1:3788/';
const perfil = process.argv[3] || 'a56';
const cfg = PERFILES[perfil];
if (!cfg) {
  console.log(`perfil desconocido: ${perfil}. Hay: ${Object.keys(PERFILES).join(', ')}`);
  process.exit(1);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: cfg.viewport,
  deviceScaleFactor: cfg.deviceScaleFactor,
  isMobile: cfg.isMobile ?? false,
  hasTouch: cfg.hasTouch ?? false,
  userAgent: cfg.userAgent,
});
const page = await context.newPage();
const errores = [];
page.on('pageerror', (e) => errores.push(String(e).slice(0, 160)));
page.on('console', (m) => {
  if (m.type() === 'error') errores.push(m.text().slice(0, 160));
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);

const informe = await page.evaluate(() => {
  const rect = (sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) };
  };
  const topbar = document.querySelector('.topbar');
  const hijos = topbar
    ? [...topbar.children].map((c) => {
        const r = c.getBoundingClientRect();
        return { clase: String(c.className).slice(0, 18), y: Math.round(r.y), h: Math.round(r.height) };
      })
    : [];
  const filas = [...new Set(hijos.map((h) => h.y))];
  const vacios = [...document.querySelectorAll('div, section, aside')]
    .filter((n) => n.children.length === 0 && !(n.textContent ?? '').trim())
    .map((n) => {
      const r = n.getBoundingClientRect();
      return { clase: String(n.className).slice(0, 24), h: Math.round(r.height) };
    })
    .filter((v) => v.h >= 24);

  return {
    titulo: (document.querySelector('.chat-title')?.textContent ?? '').trim().slice(0, 48),
    topbar: rect('.topbar'),
    filasTopbar: filas.length,
    hijosTopbar: hijos,
    contenedoresVacios: vacios.slice(0, 6),
    transcript: rect('.scroll') ?? rect('main'),
    composer: rect('.composer'),
    desbordeHorizontal: document.documentElement.scrollWidth > window.innerWidth + 1,
    altoDocumento: document.documentElement.scrollHeight,
  };
});

await page.screenshot({ path: `tools/shots/movil-${perfil}.png` });
console.log(JSON.stringify({ perfil: cfg.nombre, viewport: `${cfg.viewport.width}x${cfg.viewport.height}`, ...informe, errores }, null, 2));
await browser.close();
