import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(1500);
await p.click('[data-id]');
await p.waitForTimeout(4000);
const info = await p.evaluate(() => {
  const o = (window.__aegisWeb.state.current.configOptions || []).find((x) => x.id === 'provider' && (x.options || []).length > 1);
  const elegido = o.options.map((y) => y.value).find((v) => v !== o.currentValue);
  localStorage.setItem('aegis.chipCache', JSON.stringify([{ id: o.id, name: o.name || o.id, type: 'select', currentValue: elegido, options: o.options }]));
  localStorage.setItem('aegis.pendingConfig', JSON.stringify({ [o.id]: elegido }));
  localStorage.removeItem('gweb.last');
  return { id: o.id, antes: o.currentValue, elegido };
});
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(2500);
await p.click('#btn-new');
await p.waitForTimeout(6000);
const trasCrear = await p.evaluate((id) => {
  const st = window.__aegisWeb.state;
  const o = ((st.current && st.current.configOptions) || []).find((x) => x.id === id);
  return o ? o.currentValue : null;
}, info.id);
// reintento: mismo cambio, ahora con el chat ya abierto y la sesion inicializada
await p.evaluate(([id, v]) => window.__aegisWeb.setConfig(id, v), [info.id, info.elegido]);
await p.waitForTimeout(4500);
const trasReintento = await p.evaluate((id) => {
  const o = ((window.__aegisWeb.state.current && window.__aegisWeb.state.current.configOptions) || []).find((x) => x.id === id);
  return { valor: o ? o.currentValue : null, chips: [...document.querySelectorAll('#chips .chip')].map((c) => c.textContent) };
}, info.id);
console.log(JSON.stringify({ info, trasCrear, trasReintento, aplicaAlReintentar: trasReintento.valor === info.elegido }, null, 1));
await b.close();
