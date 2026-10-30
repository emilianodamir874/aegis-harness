// Prueba del guard del reintento sin mandar prompts reales (session/prompt interceptado).
// Fija state.current a mano: la app abre con state.current = null y cargar una sesion grande
// por UI es caro; el guard solo necesita state.current.id y state.sessions.
// Uso: node tools/retry-guard-test.mjs
import { chromium } from 'playwright';

async function correr(caso) {
  const br = await chromium.launch();
  const p = await (await br.newContext({ viewport: { width: 430, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
  await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc, null, { timeout: 20000 });
  await p.waitForFunction(() => window.__aegisWeb.rpc.ready === true, null, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(3000);
  const base = await p.evaluate((caso) => {
    const w = window.__aegisWeb;
    // la sesion mas chica de la lista: nada mas liviano para el test
    const ss = (w.state.sessions || []).slice().sort((a, b) => ((a._meta && a._meta.messageCount) || 0) - ((b._meta && b._meta.messageCount) || 0));
    const objetivo = ss[0];
    w.state.current = { id: objetivo.sessionId };
    const rpc = w.rpc, orig = rpc.request.bind(rpc);
    window.__log = { llamadas: 0, sid: objetivo.sessionId, antes: (objetivo._meta && objetivo._meta.messageCount) || null };
    rpc.request = function (m, pr) {
      if (m === 'session/prompt') {
        window.__log.llamadas++;
        return Promise.reject(new Error('WebSocket is closed'));
      }
      if (m === 'session/list' && caso === 'llego') {
        // Simula que el server REPORTA un mensaje mas (asi lo ve refreshSessions, que reemplaza
        // state.sessions con la respuesta fresca: mutar la copia vieja no servia de nada).
        return orig(m, pr).then(function (res) {
          const arr = (res && res.sessions) || [];
          const t = arr.find(function (x) { return x && x.sessionId === window.__log.sid; });
          if (t && t._meta) t._meta.messageCount = (t._meta.messageCount || 0) + 1;
          return res;
        });
      }
      return orig(m, pr);
    };
    return window.__log;
  }, caso);
  await p.fill('#input', 'prueba del guard');
  await p.click('#btn-send');
  await p.waitForTimeout(28000);
  const out = await p.evaluate(() => ({ llamadas: window.__log.llamadas, composer: document.getElementById('input').value }));
  await br.close();
  return { base, out };
}

for (const caso of ['no-llego', 'llego']) {
  try {
    const r = await correr(caso);
    const esperado = caso === 'llego' ? 1 : 3;
    console.log((r.out.llamadas === esperado ? 'OK   ' : 'FALLA') + ' ' + caso + ': session/prompt=' + r.out.llamadas + ' (esperado ' + esperado + '), sid=' + r.base.sid + ', countBase=' + r.base.antes + ', composer=' + JSON.stringify(String(r.out.composer).slice(0, 24)));
  } catch (e) { console.log('HARNESS ERROR ' + caso + ': ' + String(e.message).slice(0, 130)); }
}