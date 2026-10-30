import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc && window.__aegisWeb.rpc.ready === true, null, { timeout: 30000 });
await p.evaluate(() => { try { window.__aegisWeb.refreshSessions(); } catch (e) {} });
await p.waitForSelector('.sb-item', { timeout: 30000 });
const out = await p.evaluate(async () => {
  const A = window.__aegisWeb;
  const ids = A.state.sessions.slice(0, 6).map((s) => s.sessionId);
  const res = [];
  for (const id of ids) {
    try {
      const r = await A.rpc.request('session/load', { sessionId: id, cwd: 'C:/Aegis-Proyects', mcpServers: [], _meta: { replayTail: 1 } });
      const o = r.configOptions || [];
      const prov = o.find((x) => x.id === 'provider');
      const mod = o.find((x) => x.id === 'model');
      res.push({ id, titulo: String((r.title || '') ).slice(0, 40), provider: prov && prov.currentValue, model: mod && mod.currentValue });
    } catch (e) { res.push({ id, error: (e && e.message) || String(e) }); }
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(0);