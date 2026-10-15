// aegis-web debug probe: maps main-pane states (home / new chat / opened session)
// and dumps console + DOM facts. Run: cd ui/desktop && node scripts/web-debug.mjs
import { chromium } from '@playwright/test';

const url = process.argv[2] || 'http://127.0.0.1:3788/';
const logs = [];
let browser;
let context;
if (process.env.BRAVE_USER_DATA) {
  context = await chromium.launchPersistentContext(process.env.BRAVE_USER_DATA, {
    executablePath: process.env.BRAVE_PATH || undefined,
    headless: true,
    viewport: { width: 1600, height: 900 },
  });
  browser = context;
} else {
  const launchOpts = process.env.BRAVE_PATH
    ? { executablePath: process.env.BRAVE_PATH, headless: true }
    : { channel: 'chrome', headless: true };
  browser = await chromium.launch(launchOpts);
}
try {
  const page = context ? await context.newPage() : await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`.slice(0, 260)));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e && e.message).slice(0, 260)}`));

  const snap = async (label) => {
    const data = await page.evaluate(() => {
      const root = document.getElementById('root');
      const body = document.body;
      const main = root ? root.querySelector('main, [class*="main"], [class*="Main"]') : null;
      const textareas = document.querySelectorAll('textarea').length;
      const buttons = Array.from(document.querySelectorAll('button'))
        .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim())
        .filter(Boolean)
        .slice(0, 30);
      // capture candidate scrollable content areas
      const containers = Array.from(document.querySelectorAll('div')).filter(
        (d) => d.scrollHeight > 200 && d.clientHeight > 200
      ).length;
      return {
        rootLen: root ? root.innerHTML.length : 0,
        bodyText: (body.innerText || '').slice(0, 500),
        mainFound: !!main,
        mainText: main ? (main.innerText || '').slice(0, 300) : null,
        textareas,
        buttons,
        bigScrollableDivs: containers,
        url: location.href,
      };
    });
    console.log(`\n===== ${label} =====`);
    console.log(JSON.stringify(data, null, 2));
  };

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  await snap('STATE 1: initial load (modal probably present)');

  for (const label of ['Cerrar', 'No, gracias', 'Close']) {
    const btn = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
    try {
      if (await btn.isVisible({ timeout: 1200 })) {
        await btn.click();
        console.log(`dismissed modal via "${label}"`);
        break;
      }
    } catch {}
  }
  await page.waitForTimeout(1500);
  await snap('STATE 2: after modal dismissed');

  try {
    const nuevo = page.getByText('Nuevo chat', { exact: true }).first();
    if (await nuevo.isVisible({ timeout: 2000 })) {
      await nuevo.click();
      await page.waitForTimeout(2000);
      console.log('clicked Nuevo chat');
    }
  } catch {}
  await snap('STATE 3: after clicking Nuevo chat');

  // Try opening the first session in the list
  try {
    const first = page.getByText('Emiliano', { exact: true }).first();
    if (await first.isVisible({ timeout: 2000 })) {
      await first.click();
      await page.waitForTimeout(4000);
      console.log('clicked first session (Emiliano)');
    }
  } catch {}
  await snap('STATE 4: after opening a session');

  console.log('\n===== console =====');
  console.log(logs.slice(0, 100).join('\n'));
} finally {
  await browser.close();
}
