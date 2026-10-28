// Captura la UI viva de aegis-web para inspeccion visual.
// uso: node tools/shot.mjs [url] [outPrefix] [--w=1440] [--h=900] [--session=ID]
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const get = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const url = args[0] && !args[0].startsWith('--') ? args[0] : 'http://127.0.0.1:3788/';
const prefix = args[1] && !args[1].startsWith('--') ? args[1] : 'shot';
const W = Number(get('w', 1440));
const H = Number(get('h', 900));
const sessionId = get('session', '');

const outDir = 'C:/Aegis-Proyects/web/outbox/_shots';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true }).catch(() =>
  chromium.launch({ headless: true })
);
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 300)));

const target = sessionId ? `${url.replace(/\/$/, '')}/#/s/${sessionId}` : url;
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2500);

await page.screenshot({ path: `${outDir}/${prefix}-01-home.png` });

// abre el primer chat de la lista si existe
const first = page.locator('.sb-item').first();
if (await first.count()) {
  await first.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${outDir}/${prefix}-02-chat.png` });
  await page.screenshot({ path: `${outDir}/${prefix}-02-chat-full.png`, fullPage: true });
}

// mobile
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/${prefix}-03-mobile.png` });

// diagnostico de tokens visuales
const info = await page.evaluate(() => {
  const g = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p) : null);
  const root = document.documentElement;
  const body = document.body;
  const first = document.querySelector('.msg-a .content') || document.querySelector('.msg');
  return {
    classes: body.className,
    fontBody: g(body, 'font-family'),
    fontBodySize: g(body, 'font-size'),
    colorBg: g(body, 'background-color'),
    colorText: g(body, 'color'),
    rootTokens: [...getComputedStyle(root)]
      .filter((k) => k.startsWith('--'))
      .map((k) => `${k}: ${getComputedStyle(root).getPropertyValue(k).trim()}`)
      .slice(0, 80),
    msgLineHeight: g(first, 'line-height'),
    msgMaxWidth: g(first, 'max-width'),
    shell: [...document.body.children].map((e) => e.id || e.className),
  };
});
fs.writeFileSync(`${outDir}/${prefix}-info.json`, JSON.stringify({ errors, info }, null, 2));
console.log(JSON.stringify({ ok: true, errors: errors.slice(0, 8), info }, null, 2).slice(0, 4000));
await browser.close();
