import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(1500);
// capturar las opciones reales del servidor para armar una eleccion valida (un proveedor de verdad)
await p.click('[data-id]');
await p.waitForTimeout(3500);
const armado = await p.evaluate(() => {
  const o = (window.__aegisWeb.state.current.configOptions || []).find((x) => x.id === 'provider');
  const cache = [{ id: 'provider', name: o.name, type: 'select', currentValue: 'antigravity', options: o.options }];
  localStorage.setItem('aegis.chipCache', JSON.stringify(cache));
  localStorage.setItem('aegis.pendingConfig', JSON.stringify({ provider: 'antigravity' }));
  localStorage.removeItem('gweb.last');
  return { opciones: o.options.map((x) => x.value), eleccion: 'antigravity' };
});
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(3000);
const bienvenida = await p.evaluate(() => ({
  hayChat: !!(window.__aegisWeb.state.current && window.__aegisWeb.state.current.id),
  chips: [...document.querySelectorAll('#chips .chip')].map((c) => c.textContent),
  infoOculta: document.getElementById('default-model-chip').hidden,
}));
await p.click('#btn-new');
await p.waitForTimeout(7000);
const tras = await p.evaluate(async () => {
  const st = window.__aegisWeb.state;
  const o = ((st.current && st.current.configOptions) || []).find((x) => x.id === 'provider');
  const notas = [...document.querySelectorAll('#messages .sys-note, #messages .note, .sys-note')].map((n) => n.textContent.trim()).slice(-2);
  const sid = st.current ? st.current.id : null;
  const resumen = { sid, proveedor: o ? o.currentValue : null, modelo: ((st.current.configOptions || []).find((x) => x.id === 'model') || {}).currentValue, chips: [...document.querySelectorAll('#chips .chip')].map((c) => c.textContent), notas, pendiente: st.pendingConfig };
  return resumen;
});
// limpieza: borrar el chat de prueba recien creado
const borrado = await p.evaluate(async (sid) => { try { await window.__aegisWeb.rpc.request('session/delete', { sessionId: sid }); return 'borrado'; } catch (e) { return 'no borrado: ' + (e && e.message); } }, tras.sid);
console.log(JSON.stringify({ armado, bienvenida, tras, aplicado: tras.proveedor === 'antigravity', borrado }, null, 1));
await b.close();
