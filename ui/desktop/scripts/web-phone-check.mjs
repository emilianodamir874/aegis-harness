// aegis-web phone check: renders at phone viewport, verifies main pane +
// composer, then tests the navigation-collapse toggle on small screens.
// Run: cd ui/desktop && node scripts/web-phone-check.mjs [url]
import { chromium } from '@playwright/test';

const url = process.argv[2] || 'http://192.168.100.34:3788/';
const launchOpts = process.env.BRAVE_PATH
  ? { executablePath: process.env.BRAVE_PATH, headless: true }
  : { channel: 'chrome', headless: true };

const browser = await chromium.launch(launchOpts);
try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message).slice(0, 200)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);

  // dismiss announcement modal if present
  for (const label of ['Cerrar', 'No, gracias']) {
    const btn = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
    try {
      if (await btn.isVisible({ timeout: 1200 })) {
        await btn.click();
        break;
      }
    } catch {}
  }
  await page.waitForTimeout(1200);

  const m = await page.evaluate(() => {
    const text = document.body.innerText || '';
    const ta = document.querySelector('textarea');
    const taRect = ta ? ta.getBoundingClientRect() : null;
    return {
      greeting: text.includes('Buenos días'),
      composer: !!ta,
      composerW: taRect ? Math.round(taRect.width) : 0,
      composerVisible: taRect ? taRect.width > 50 && taRect.height > 10 : false,
      vp: window.innerWidth + 'x' + window.innerHeight,
      bodyLen: text.length,
    };
  });
  console.log('PHONE BASIC:', JSON.stringify(m));

  // collapse navigation via the "Contraer navegación" button
  try {
    const collapse = page.getByRole('button', { name: /Contraer navegación/i }).first();
    if (await collapse.isVisible({ timeout: 2000 })) {
      await collapse.click();
      await page.waitForTimeout(1200);
      const after = await page.evaluate(() => {
        const ta = document.querySelector('textarea');
        const r = ta ? ta.getBoundingClientRect() : null;
        return { composerW: r ? Math.round(r.width) : 0 };
      });
      console.log('AFTER COLLAPSE:', JSON.stringify(after));
    } else {
      console.log('collapse button not visible');
    }
  } catch (e) {
    console.log('collapse failed:', String(e).slice(0, 120));
  }

  if (errs.length) console.log('ERRORS:', [...new Set(errs)].slice(0, 8).join(' ### '));
} finally {
  await browser.close();
}
