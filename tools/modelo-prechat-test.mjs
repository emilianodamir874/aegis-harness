import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext();
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(1500);
await p.click('[data-id]');
await p.waitForTimeout(4000);
const info = await p.evaluate(() => {
  const prov = (window.__aegisWeb.state.current.configOptions || []).find((o) => o.id === 'provider' && (o.options || []).length > 1);
  const base = prov || (window.__aegisWeb.state.current.configOptions || []).find((o) => (o.options || []).length > 1);
  const elegido = (base.options.map((x) => x.value).find((v) => v !== base.currentValue)) || base.currentValue;
  localStorage.setItem('aegis.chipCache', JSON.stringify([{ id: base.id, name: base.name || base.id, type: 'select', currentValue: elegido, options: base.options }]));
  localStorage.setItem('aegis.pendingConfig', JSON.stringify({ [base.id]: elegido }));
  localStorage.removeItem('gweb.last');   // para caer en la pantalla de bienvenida, sin chat abierto
  return { id: base.id, antes: base.currentValue, elegido };
});
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(3000);
const bienvenida = await p.evaluate(() => ({
  hayChat: !!(window.__aegisWeb.state.current && window.__aegisWeb.state.current.id),
  chipsCache: [...document.querySelectorAll('#chips .chip')].map((c) => c.textContent),
  infoOculta: document.getElementById('default-model-chip').hidden,
  pendiente: window.__aegisWeb.state.pendingConfig || {},
}));
await p.click('#btn-new');
await p.waitForTimeout(7000);
const trasCrear = await p.evaluate((id) => {
  const st = window.__aegisWeb.state;
  const o = ((st.current && st.current.configOptions) || []).find((x) => x.id === id);
  return { hayChat: !!(st.current && st.current.id), idBuscado: id, valorAhora: o ? o.currentValue : null, pendiente: st.pendingConfig || {}, chips: [...document.querySelectorAll('#chips .chip')].map((c) => c.textContent) };
}, info.id);
console.log(JSON.stringify({ info, bienvenida, trasCrear, aplicado: trasCrear.valorAhora === info.elegido, errs }, null, 1));
await b.close();
