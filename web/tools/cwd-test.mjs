import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 25000 });
await p.waitForTimeout(3000);
const res = await p.evaluate(async () => {
  const out = { cwdDelConfig: (window.__AEGIS_APP__ || {}).cwd, listo: window.__aegisWeb.rpc.ready };
  out.viejo = { proveedor: null };
  try {
    const r = await window.__aegisWeb.rpc.request('session/new', { cwd: out.cwdDelConfig, mcpServers: [] });
    out.creada = { ok: true, sid: r.sessionId, opciones: (r.configOptions || []).map((o) => o.id + '=' + o.currentValue) };
  } catch (e) { out.creada = { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) }; }
  if (out.creada && out.creada.ok) {
    try { const i = await window.__aegisWeb.rpc.request('_aegis/unstable/session/info', { sessionId: out.creada.sid }); out.info = JSON.stringify(i).slice(0, 260); } catch (e) { out.info = 'err ' + e.message; }
  }
  return out;
});
console.log(JSON.stringify({ res, errs }, null, 1));
await b.close();
