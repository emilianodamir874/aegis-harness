import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(1800);
const fila = await p.$('[data-id]');
if (fila) { await fila.click().catch(() => {}); await p.waitForTimeout(3000); }
const s = [];
for (let i = 0; i < 14; i++) {
  await p.keyboard.press('Tab');
  const info = await p.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const indicador = st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0;
    return { quien: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''), foco: indicador, sombra: st.boxShadow !== 'none', size: Math.round(r.width) + 'x' + Math.round(r.height), ver: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20) };
  });
  if (info) s.push(info);
}
console.log(JSON.stringify({ secuencia: s, errs: [] }, null, 1));
await b.close();
