// Verifica la señal que usa el guard del reintento: que el cliente tenga a mano
// _meta.messageCount de la sesion activa (si no, el guard nunca se activa).
import { chromium } from 'playwright';
const br = await chromium.launch();
const p = await (await br.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc, null, { timeout: 20000 });
await p.waitForFunction(() => window.__aegisWeb.rpc.ready === true, null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(3000);
const out = await p.evaluate(async () => {
  const expuesto = Object.keys(window.__aegisWeb || {});
  const r = await window.__aegisWeb.rpc.request('session/list', { meta: { aegis: { includeLastMessageSnippet: false } } });
  const s = (r && r.sessions && r.sessions[0]) || {};
  return {
    expuesto: expuesto,
    messageCountDelPrimero: (s._meta && s._meta.messageCount) || null,
    tipoDelConteo: typeof ((s._meta && s._meta.messageCount)),
  };
});
console.log(JSON.stringify(out));
await br.close();