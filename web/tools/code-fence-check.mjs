// Verifica el bloque de codigo con lenguaje: data-lang, cabecera y boton Copiar visible.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 140)));
await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.locator('.sb-item').first().click().catch(() => {});
await page.waitForTimeout(1500);

const fence = 'texto\n\n```ts\nconst a = 1;\nconsole.log(a);\n```\n\nfin';
const r = await page.evaluate((src) => {
  const app = window.__aegisWeb;
  const n = document.createElement('div');
  n.className = 'msg-a';
  n.id = 'fx';
  n.innerHTML = '<div class="content">' + app.md(src) + '</div>';
  document.querySelector('#msg-inner').append(n);
  const w = n.querySelector('.code-wrap');
  const pre = n.querySelector('pre');
  const btn = w.querySelector('.copy-code');
  return {
    className: w.className,
    lang: w.dataset.lang,
    before: getComputedStyle(w, '::before').content,
    beforeColor: getComputedStyle(w, '::before').color,
    padTop: getComputedStyle(pre).paddingTop,
    copyOpacity: getComputedStyle(btn).opacity,
    codeText: n.querySelector('pre code').textContent,
  };
}, fence);
await page.evaluate(() => document.querySelector('#fx').scrollIntoView({ block: 'center' }));
await page.waitForTimeout(300);
await page.screenshot({ path: 'C:/Aegis-Proyects/web/outbox/_shots/v9-code.png' });
console.log(JSON.stringify({ ...r, errs }, null, 1));
if (r.lang !== 'ts' || r.className !== 'code-wrap lang' || r.before.indexOf('ts') < 0 || r.codeText.indexOf('const a = 1') < 0) process.exit(1);
await browser.close();
