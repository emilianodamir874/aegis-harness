// Capturas rápidas del estado final (desktop + phone) para control visual.
import { chromium } from '@playwright/test';
const url = process.argv[2] || 'http://192.168.100.34:3788/';
const shots = 'C:/Aegis-Proyects/web/tools/shots';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 }).catch(() => {});
  await p.waitForTimeout(1500);
  await p.screenshot({ path: shots + '/final-desktop-boot.png' });
  // captura con menú de modelo abierto
  const chip = p.locator('.chip[title="Model"]');
  if (await chip.count()) {
    await chip.click();
    await p.waitForTimeout(400);
    await p.screenshot({ path: shots + '/final-desktop-menu.png' });
  }
  await ctx.close();

  const pctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Mobile Safari/537.36',
  });
  const ph = await pctx.newPage();
  await ph.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ph.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 }).catch(() => {});
  await ph.waitForTimeout(1200);
  await ph.screenshot({ path: shots + '/final-phone-boot.png' });
  await ph.click('#btn-menu');
  await ph.waitForTimeout(500);
  await ph.screenshot({ path: shots + '/final-phone-drawer.png' });
  await pctx.close();
  console.log('shots ok');
} finally {
  await browser.close();
}
