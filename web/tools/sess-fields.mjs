// Que campos devuelve session/list: buscamos un contador de mensajes para verificar si un
// prompt llego (sin el, la unica verificacion es 'hay un run corriendo', que no alcanza).
import { chromium } from 'playwright';
const br = await chromium.launch();
const p = await (await br.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc, null, { timeout: 20000 });
await p.waitForFunction(() => window.__aegisWeb.rpc.ready === true, null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2500);
const out = await p.evaluate(async () => {
  const r = await window.__aegisWeb.rpc.request('session/list', { meta: { aegis: { includeLastMessageSnippet: false } } });
  const s = (r && r.sessions && r.sessions[0]) || null;
  const meta = (r && (r._meta || r.meta)) || {};
  return {
    sesiones: (r && r.sessions || []).length,
    clavesSesion: s ? Object.keys(s) : [],
    metaClaves: Object.keys(meta),
    runningIds: (meta.runningSessionIds || []).length,
    muestra: s ? JSON.stringify(s).slice(0, 500) : null,
  };
});
console.log(JSON.stringify(out, null, 1));
await br.close();