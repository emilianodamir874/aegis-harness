import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(1500);
await p.click('[data-id]');
await p.waitForTimeout(4000);
const res = await p.evaluate(async () => {
  const rpc = window.__aegisWeb.rpc;
  const sid = window.__aegisWeb.state.current.id;
  const salida = {};
  try {
    const r = await rpc.request('session/set_config_option', { sessionId: sid, configId: 'provider', value: 'aegis' });
    salida.provider = { ok: true, devuelve: (r.configOptions || []).map((o) => o.id + '=' + o.currentValue) };
  } catch (e) { salida.provider = { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) }; }
  try {
    const r2 = await rpc.request('session/set_config_option', { sessionId: sid, configId: 'thinking_effort', value: 'high' });
    salida.effort = { ok: true, devuelve: (r2.configOptions || []).map((o) => o.id + '=' + o.currentValue) };
  } catch (e) { salida.effort = { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) }; }
  return salida;
});
console.log(JSON.stringify(res, null, 1));
await b.close();
