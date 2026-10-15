// Render de tablas markdown (v6.3): casos normales, alineación, code block con pipes,
// tabla sin cuerpo, tabla pegada a texto, pipes escapados.
import { chromium } from '@playwright/test';
const md = [
  { k: 'tabla-basica', t: '| Escenario | p50 | long tasks |\n|---|---|---|\n| Reposo, 1.167 msgs | 3,1 ms | 0 |\n| Run activo | ~19 ms | 0 |' },
  { k: 'alineacion', t: '| izq | centro | der |\n|:---|:---:|---:|\n| a | b | 12,3 ms |' },
  { k: 'sin-cuerpo', t: '| A | B |\n|---|---|' },
  { k: 'con-texto', t: 'Antes de la tabla.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDespués de la tabla.' },
  { k: 'inline-en-celdas', t: '| qué | cómo |\n|---|---|\n| **negrita** | `codigo` y [link](https://x.y) |' },
  { k: 'code-con-pipes', t: '```bash\ncat a | grep b | wc -l\n```' },
  { k: 'no-es-tabla', t: 'a | b sin separador\nsigo texto' },
  { k: 'listas-ok', t: '- uno\n- dos\n\n1. tres\n\n> cita\n\n## H2' },
];
const br = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__aegisWeb && typeof window.__aegisWeb.md === 'function', null, { timeout: 60000 });
const res = {};
for (const c of md) {
  res[c.k] = await page.evaluate((t) => {
    const html = window.__aegisWeb.md(t);
    const d = document.createElement('div');
    d.innerHTML = html;
    return {
      html: html.replace(/\s+/g, ' ').slice(0, 260),
      tablas: d.querySelectorAll('table').length,
      th: d.querySelectorAll('th').length, td: d.querySelectorAll('td').length,
      align: [...d.querySelectorAll('th')].map((e) => e.style.textAlign || '-').join(','),
      pipesVisibles: /^\s*\|/m.test(d.textContent) || d.textContent.includes('|---'),
      parrafos: d.querySelectorAll('p').length, li: d.querySelectorAll('li').length, h2: d.querySelectorAll('h2').length, pre: d.querySelectorAll('pre').length,
    };
  }, c.t);
}
// pintado real + captura
const shot = await page.evaluate(() => {
  const box = document.querySelector('#messages') || document.body;
  const art = document.createElement('article');
  art.className = 'msg msg-a';
  art.innerHTML = '<div class="content">' + window.__aegisWeb.md('| Escenario | p50 tecla→frame | long tasks |\n|---|---|---|\n| Reposo, sesión de 1.167 mensajes (13.343 nodos) | 3,1 ms | 0 |\n| Con run activo (streaming propio o adoptado) | ~19 ms (≈1 frame) | 0 |\n| **Refresco del turno adoptado** (rebuild completo del DOM) | — | **2.310 ms, tramos de hasta 206 ms** |') + '</div>';
  box.appendChild(art);
  const w = art.querySelector('.tbl-wrap');
  return { anchoWrap: Math.round(w.getBoundingClientRect().width), scrollX: w.scrollWidth, desbordaPagina: document.documentElement.scrollWidth > window.innerWidth + 1 };
});
await page.screenshot({ path: 'C:/Aegis-Proyects/web/tools/shots/tabla-markdown-mobile.png' });
console.log(JSON.stringify({ ...res, pintado: shot, errores: errs }, null, 1));
await br.close();
process.exit(0);
