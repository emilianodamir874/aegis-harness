// Capturas de como se ve una tabla markdown con el render real, en telefono y escritorio.
// Uso: node tools/tabla-shots.mjs
import { chromium } from 'playwright';

const MD = [
  '| | `http://…:3788` | `https://…:3789` |',
  '|---|---|---|',
  '| `isSecureContext` | `false` | **`true`** |',
  '| `navigator.mediaDevices` | no existe | **disponible** |',
  '| tocar el micrófono | no graba | graba (`rec`) |',
  '| pedido al backend | ninguno | **`dictation/transcribe` con 42,6 KB de audio (groq)** |',
  '| errores de página | 0 | 0 |',
  '',
  '| Componente | Estado | Evidencia |',
  '|---|---|---|',
  '| serve `3284` | corriendo desde `Aegis-Proyects\\core\\bin\\aegis-current.exe` | `/health` 200 |',
  '| web `3788` / `3789` | corriendo | `/healthz` 200 |',
].join('\n');

const out = process.argv[2] || 'C:/Aegis-Proyects/tmp';
const br = await chromium.launch();
const errs = [];

for (const [name, width, height] of [['phone', 390, 844], ['phone-xs', 360, 780], ['desktop', 1280, 800]]) {
  const ctx = await br.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(name + ': ' + String(e.message).slice(0, 160)));
  await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
  await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.md, null, { timeout: 20000 });
  const html = await p.evaluate((md) => window.__aegisWeb.md(md), MD);
  const labels = await p.evaluate((h) => {
    const d = document.createElement('div');
    d.innerHTML = h;
    return Array.from(d.querySelectorAll('td')).slice(0, 6).map((td) => td.getAttribute('data-label'));
  }, html);
  await p.evaluate((h) => {
    document.body.innerHTML = '<div class="msgs" style="padding:12px"><div class="msg-a"><div class="content">' + h + '</div></div></div>';
    document.body.style.background = getComputedStyle(document.body).backgroundColor || '#0f1115';
  }, html);
  await p.waitForTimeout(400);
  const file = out + '/tabla-' + name + '.png';
  await p.screenshot({ path: file, fullPage: true });
  const scroll = await p.evaluate(() => {
    const w = document.querySelector('.tbl-wrap');
    return w ? { scrollW: w.scrollWidth, clientW: w.clientWidth, overflow: w.scrollWidth > w.clientWidth + 4 } : null;
  });
  console.log(name + ' (' + width + 'px): ' + file + ' | data-labels=' + JSON.stringify(labels) + ' | wrap=' + JSON.stringify(scroll));
  await ctx.close();
}
console.log('errores: ' + JSON.stringify(errs));
await br.close();
