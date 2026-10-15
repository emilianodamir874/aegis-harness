// Barrido de viewports: verifica que la UI no desborde horizontalmente,
// que el composer sea visible y que la navegación condicional funcione en
// 9 tamaños (teléfonos chicos -> monitores grandes). Guarda capturas clave.
// Run: cd ui/desktop && node scripts/aegis-web-viewports.mjs [url]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://192.168.100.34:3788/';
const shots = 'C:/aegis-web/tools/shots';
mkdirSync(shots, { recursive: true });

const VIEWPORTS = [
  [360, 740, 'phone-360'],
  [375, 812, 'phone-375'],
  [390, 844, 'phone-390'],
  [414, 896, 'phone-414'],
  [768, 1024, 'tablet-768'],
  [1024, 768, 'small-1024'],
  [1280, 800, 'laptop-1280'],
  [1600, 900, 'desktop-1600'],
  [1920, 1080, 'desktop-1920'],
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
for (const [w, h, name] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w <= 480, hasTouch: w <= 480 });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 }).catch(() => {});
    // Los chips (proveedor/modo/modelo) solo existen con una sesión abierta: abrimos
    // la primera del sidebar, si no el barrido mide la fila vacía.
    await p.waitForFunction(() => document.querySelectorAll('.sb-item').length > 0, null, { timeout: 20000 }).catch(() => {});
    if (w <= 880) { await p.click('#btn-menu').catch(() => {}); await p.waitForTimeout(400); } // esperar la animación del drawer
    await p.locator('.sb-item').first().click({ force: true }).catch(() => {});
    await p.waitForFunction(() => document.querySelectorAll('.chip').length > 0, null, { timeout: 40000 }).catch(() => {});
    await p.waitForTimeout(700);
    const m = await p.evaluate(() => {
      const de = document.documentElement;
      const chips = document.querySelector('#chips');
      const chipRect = chips && chips.children.length ? chips.getBoundingClientRect() : null;
      const composer = document.querySelector('.composer').getBoundingClientRect();
      const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
      const title = document.querySelector('#chat-title');
      return {
        hOverflow: de.scrollWidth - window.innerWidth,
        vOverflow: de.scrollHeight - window.innerHeight,
        composerVisible: composer.width > 60 && composer.bottom <= window.innerHeight + 2,
        composerRight: Math.round(composer.right),
        chipsRight: chipRect ? Math.round(chipRect.right) : null,
        chipsOverflow: chipRect ? Math.max(0, Math.round(chipRect.right - window.innerWidth)) : null,
        sidebarVisible: sidebar.left >= -4 && sidebar.width > 4,
        titleClipped: title ? title.scrollWidth - title.clientWidth : 0,
        mobile: window.innerWidth <= 880,
      };
    });
    results.push({ name, w, h, ...m, errs });
    if ([360, 390, 768, 1024, 1920].includes(w)) {
      await p.screenshot({ path: `${shots}/vp-${name}.png` });
    }
  } catch (e) {
    results.push({ name, w, h, error: String(e).slice(0, 240), errs });
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(results, null, 1));
