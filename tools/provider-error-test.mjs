import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(1500);
await p.click('[data-id]');
await p.waitForTimeout(4000);
const antes = await p.evaluate(() => {
  const o = (window.__aegisWeb.state.current.configOptions || []).find((x) => x.id === 'provider');
  return { valor: o ? o.currentValue : null, nombre: o ? (o.options.find((y) => y.value === o.currentValue) || {}).name : null, opciones: o ? o.options.map((y) => y.value) : [] };
});
// se llama al mismo camino que usan los selectores y se leen los avisos en pantalla
await p.evaluate(() => { window.__notas = []; const obs = new MutationObserver(() => { document.querySelectorAll('#messages .sys-note, #messages .note, .sys-note').forEach((n) => { const t = n.textContent.trim(); if (t && !window.__notas.includes(t)) window.__notas.push(t); }); }); obs.observe(document.body, { childList: true, subtree: true }); });
await p.evaluate(() => window.__aegisWeb.setConfig('provider', 'aegis'));
await p.waitForTimeout(5000);
const despues = await p.evaluate(() => {
  const o = (window.__aegisWeb.state.current.configOptions || []).find((x) => x.id === 'provider');
  return { valor: o ? o.currentValue : null, chips: [...document.querySelectorAll('#chips .chip')].map((c) => c.textContent), notas: window.__notas };
});
console.log(JSON.stringify({ antes, despues }, null, 1));
await b.close();
