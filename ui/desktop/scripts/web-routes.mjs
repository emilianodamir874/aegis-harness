// aegis-web route scan: visits every hash route and reports whether the main
// pane renders content. Run: cd ui/desktop && node scripts/web-routes.mjs [base]
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://192.168.100.34:3788';
const routes = ['/', '/sessions', '/schedules', '/recipes', '/skills', '/settings', '/extensions', '/configure-providers'];
const logs = [];

const launchOpts = process.env.BRAVE_PATH
  ? { executablePath: process.env.BRAVE_PATH, headless: true }
  : { channel: 'chrome', headless: true };
const browser = await chromium.launch(launchOpts);
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e && e.message).slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(`[console.error] ${m.text().slice(0, 200)}`);
  });

  for (const r of routes) {
    await page.goto(base + '/#' + r.replace(/^\//, '/'), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2600);
    // dismiss modal if it appears (only on first load, but harmless)
    for (const label of ['Cerrar', 'No, gracias']) {
      const btn = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
      try {
        if (await btn.isVisible({ timeout: 700 })) {
          await btn.click();
          await page.waitForTimeout(600);
          break;
        }
      } catch {}
    }
    const data = await page.evaluate(() => {
      const text = (document.body.innerText || '');
      const hasComposer = document.querySelectorAll('textarea').length;
      // main pane = text after the sidebar list; approximate by looking for known markers
      const markers = ['Buenos días', 'Historial', 'Recetas', 'Programador', 'Extensiones', 'Ajustes'];
      return {
        len: text.length,
        hasComposer,
        hasGreeting: text.includes('Buenos días'),
        tail: text.slice(-260).replace(/\n+/g, ' | '),
      };
    });
    console.log(`ROUTE ${r.padEnd(22)} len=${String(data.len).padEnd(6)} composer=${data.hasComposer} greeting=${data.hasGreeting}`);
    console.log(`   tail: ${data.tail}`);
  }

  if (logs.length) {
    console.log('\nERRORS:');
    console.log([...new Set(logs)].slice(0, 20).join('\n'));
  }
} finally {
  await browser.close();
}
