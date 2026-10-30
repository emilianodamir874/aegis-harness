import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'networkidle', timeout: 30000 });
await p.waitForTimeout(1500);
const out = await p.evaluate(async () => {
  const rpc = window.__aegisWeb.rpc;
  const res = [];
  const creada = await rpc.request('session/new', { cwd: 'C:\\Aegis-Proyects', mcpServers: [] });
  const sid = creada.sessionId;
  res.push({ sid, opts: (creada.configOptions || []).map((o) => o.id + '=' + o.currentValue) });
  const intentos = [
    { etq: 'value plano', params: { sessionId: sid, configId: 'model', value: 'deepseek-v4.1-flash-max' } },
    { etq: 'valueId objeto', params: { sessionId: sid, configId: 'model', value: { type: 'select', valueId: 'deepseek-v4.1-flash-max' } } },
    { etq: 'value effort', params: { sessionId: sid, configId: 'thinking_effort', value: 'max' } },
  ];
  for (const t of intentos) {
    try {
      const r = await rpc.request('session/set_config_option', t.params);
      res.push({ [t.etq]: 'OK', opts: (r.configOptions || []).map((o) => o.id + '=' + o.currentValue) });
    } catch (e) {
      res.push({ [t.etq]: String(e && e.message ? e.message : e).slice(0, 300), data: e && e.data ? JSON.stringify(e.data).slice(0, 300) : null });
    }
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await b.close();
