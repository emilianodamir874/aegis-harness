// Repro del flujo real: steer atrapado + reload inmediato -> al reabrir, el cliente
// debe REENVIARLO como mensaje (flushPendingSteers) y el agente responder.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const out = {};
let id = 0; const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message || 'rpc'), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'flush-repro', version: '1' } });

const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
try {
  await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(2000);

  await p.click('#btn-new');
  await p.waitForTimeout(1500);
  await p.fill('#input', 'Ejecutá shell: powershell -NoProfile -Command "Start-Sleep -Seconds 60". Después respondé FIN-LARGO.');
  await p.press('#input', 'Enter');
  await p.waitForTimeout(5000);
  out.sid = await p.evaluate(() => localStorage.getItem('gweb.last'));
  out.busy1 = await p.evaluate(() => !!(window.__gooseWeb?.state?.busy));

  await p.fill('#input', 'MARCA-FLUSH-77: cuando lo veas respondé ZZFLUSH77.');
  await p.press('#input', 'Enter');
  await p.waitForTimeout(2000);
  out.queued = await p.evaluate(() => !!document.querySelector('.msg-user.queued'));
  out.pendingAntes = await p.evaluate(() => (window.__gooseWeb?.pendingSteers ? window.__gooseWeb.pendingSteers().length : window.__gooseWeb?.pendingSteers?.()?.length ?? 'n/a'));

  // cancelar el run DESDE AFUERA (el dueño es la página; el cancel llega por otro ws)
  await req('session/cancel', { sessionId: out.sid }).then(() => out.cancelEnviado = true).catch((e) => out.cancelErr = String(e).slice(0, 90));

  // RELOAD INMEDIATO: mata la pagina antes del settle del dueno -> queda el pending en localStorage
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
  out.sidTrasReload = await p.evaluate(() => localStorage.getItem('gweb.last'));

  out.serie = [];
  for (let i = 0; i < 50; i++) {
    await p.waitForTimeout(2000);
    const st = await p.evaluate(() => {
      const asist = [...document.querySelectorAll('.msg-a')];
      const user = [...document.querySelectorAll('.msg-user')];
      return {
        notas: [...document.querySelectorAll('.sysnote')].map((e) => e.innerText).filter((x) => /sin respuesta|se reenv|indicaci/i.test(x)),
        respZZ: asist.some((e) => e.innerText.includes('ZZFLUSH77')),
        marcasUser: user.filter((e) => e.innerText.includes('MARCA-FLUSH-77')).length,
        busy: !!(window.__gooseWeb?.state?.busy),
        pending: (window.__gooseWeb?.pendingSteers ? window.__gooseWeb.pendingSteers().length : 'n/a'),
      };
    });
    out.serie.push(`t=${(i + 1) * 2}s busy=${st.busy ? 1 : 0} notas=${st.notas.length} marc=${st.marcasUser} pending=${st.pending} resZZ=${st.respZZ ? 1 : 0}`);
    out.final = st;
    if (st.respZZ) break;
    if (i > 12 && !st.busy && !st.notas.length) break;
  }
  out.veredicto = out.final?.respZZ ? 'OK - auto-reenvio al reabrir + respuesta'
    : (out.final?.notas.length ? 'PARCIAL - nota de reenvio, sin respuesta' : 'FALLO - no se reenvio');
} catch (e) {
  out.crash = String(e).slice(0, 220);
} finally {
  await b.close().catch(() => {});
  if (out.sid) { try { await req('session/delete', { sessionId: out.sid }); out.limpieza = 'ok'; } catch (e) { out.limpieza = String(e).slice(0, 80); } }
  ws.close();
}
console.log(JSON.stringify(out, null, 1));
process.exit(0);
