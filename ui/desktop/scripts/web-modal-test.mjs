// goose-web modal-choice test: does the main pane survive each announcement-modal
// button? Run: cd ui/desktop && node scripts/web-modal-test.mjs [base]
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://127.0.0.1:3788/';

const launchOpts = process.env.BRAVE_PATH
  ? { executablePath: process.env.BRAVE_PATH, headless: true }
  : { channel: 'chrome', headless: true };

for (const choice of ['No, gracias', 'Sí, compartir datos de uso anónimos', 'Cerrar']) {
  const browser = await chromium.launch(launchOpts);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e && e.message).slice(0, 220)));
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(`[console] ${m.text().slice(0, 220)}`);
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(5500);

    let clicked = false;
    const btn = page.getByRole('button', { name: new RegExp(choice.slice(0, 18), 'i') }).first();
    try {
      if (await btn.isVisible({ timeout: 2500 })) {
        await btn.click();
        clicked = true;
      }
    } catch {}
    await page.waitForTimeout(2500);

    const data = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        composer: document.querySelectorAll('textarea').length,
        greeting: text.includes('Buenos días'),
        tail: text.slice(-180).replace(/\n+/g, ' | '),
      };
    });
    console.log(`CHOICE "${choice}" -> clicked=${clicked} composer=${data.composer} greeting=${data.greeting}`);
    console.log(`   tail: ${data.tail}`);
    if (errs.length) console.log(`   errs: ${[...new Set(errs)].slice(0, 6).join(' ### ')}`);
  } finally {
    await browser.close();
  }
}
