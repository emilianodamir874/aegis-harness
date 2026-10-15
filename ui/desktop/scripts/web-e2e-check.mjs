// goose-web smoke check: loads the built web UI in headless system Chrome and
// reports boot state + console output. Requires: goose-web servers running
// (node C:/goose-web/server.mjs and aegis-serve-v1.exe serve), and a web build
// (pnpm exec vite build --config vite.web.config.mts).
//
// Run:  cd ui/desktop && node scripts/web-e2e-check.mjs [url]
import { chromium } from '@playwright/test';

const url = process.argv[2] || 'http://127.0.0.1:3788/';

const logs = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`.slice(0, 300)));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e && e.message).slice(0, 300)}`));
  page.on('requestfailed', (r) =>
    logs.push(`[requestfailed] ${r.url().slice(0, 160)} ${r.failure()?.errorText || ''}`)
  );

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => logs.push(`[goto] ${e.message}`));
  await page.waitForTimeout(8000);

  const state = await page.evaluate(() => {
    const root = document.getElementById('root');
    return {
      title: document.title,
      hasShim: !!window.electron,
      hasCfg: !!(window.__AEGIS_WEB__ || {}).acpUrl,
      rootLen: root ? root.innerHTML.length : 0,
      text: (document.body.innerText || '').slice(0, 1500),
    };
  });
  console.log(JSON.stringify({ state, logs: logs.slice(0, 120) }, null, 2));
} finally {
  await browser.close();
}
