import { chromium } from 'playwright';
const br = await chromium.launch();
const p = await (await br.newContext({ viewport: { width: 430, height: 900 } })).newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc, null, { timeout: 20000 });
await p.waitForTimeout(4000);
const d = await p.evaluate(() => {
  const w = window.__aegisWeb;
  const sid = w.state.current && w.state.current.id;
  const ss = w.state.sessions || [];
  const hit = ss.find((x) => x && x.sessionId === sid);
  return {
    idActual: sid,
    currentKeys: w.state.current ? Object.keys(w.state.current) : null,
    sesiones: ss.length,
    primerosIds: ss.slice(0, 3).map((x) => x && x.sessionId),
    encontro: !!hit,
    messageCount: hit && hit._meta ? hit._meta.messageCount : null,
    ready: !!w.rpc.ready,
  };
});
console.log(JSON.stringify(d, null, 1));
await br.close();