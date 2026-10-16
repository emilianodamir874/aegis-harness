import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(1500);
await p.click('[data-id]');
await p.waitForTimeout(4000);
const salida = await p.evaluate(async () => {
  const rpc = window.__aegisWeb.rpc, st = window.__aegisWeb.state, sid = st.current.id;
  const op = (id) => (st.current.configOptions || []).find((o) => o.id === id);
  const val = (id) => (op(id) ? op(id).currentValue : null);
  const out = { sid, inicio: { provider: val('provider'), modelo: val('model'), esfuerzo: val('thinking_effort'), mode: val('mode') },
    nombresProvider: op('provider') ? op('provider').options.map((o) => o.value + ' -> ' + (o.name || '')) : [],
    valoresEsfuerzo: op('thinking_effort') ? op('thinking_effort').options.map((o) => o.value) : [] };
  const llamar = async (id, v) => { try { const r = await rpc.request('session/set_config_option', { sessionId: sid, configId: id, value: v }); return { ok: true, ahora: (r.configOptions || []).map((o) => o.id + '=' + o.currentValue).join(', ') }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) }; } };
  out.cambiarAantigravity = await llamar('provider', 'antigravity');
  await new Promise((r) => setTimeout(r, 2500));
  out.trasAntigravity = { provider: val('provider'), modelo: val('model') };
  const altEffort = (op('thinking_effort') ? op('thinking_effort').options.map((o) => o.value).find((v) => v !== val('thinking_effort')) : null);
  out.cambiarEsfuerzo = await llamar('thinking_effort', altEffort);
  await new Promise((r) => setTimeout(r, 2500));
  out.trasEsfuerzo = { esfuerzo: val('thinking_effort'), a: altEffort };
  out.chipsFinales = [...document.querySelectorAll('#chips .chip')].map((c) => c.textContent);
  // volver a como estaba para no dejarlo cambiado
  out.volver = await llamar('provider', 'open_design');
  return out;
});
console.log(JSON.stringify(salida, null, 1));
await b.close();
