// Test v2 (determinista), dos fases:
// R1: run largo → browser se une a mitad (adoptado) → ¿barra? ¿cursor se apaga solo al terminar?
//     + sondeo directo del steer con expectedRunId incorrecto (captura la forma del error real).
// R2: run largo → browser se une → click Detener desde cliente adoptado → ¿el run para de verdad?
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const out = { r1: { timeline: [], probe: [] }, r2: { timeline: [], probe: [] } };

const mk = async () => {
  let id = 0; const pend = new Map(); const st = { tools: 0 };
  const ws = new WebSocket(url);
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'session/request_permission') {
      const opt = (m.params.options || []).find((o) => o.optionId === 'allow_once') || m.params.options[0];
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
      return;
    }
    if (m.method === 'session/update' && m.params && m.params.update) {
      const u = m.params.update;
      if (u.sessionUpdate === 'tool_call' && u.status !== 'in_progress') { st.tools += 1; st.lastTool = u.title; st.toolsAt = Date.now(); }
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
  return { ws, req, st };
};

const snap = (pg) => pg.evaluate(() => {
  const bar = document.querySelector('#runbar');
  const hidden = !bar || bar.hidden;
  return {
    t: new Date().toLocaleTimeString('es-AR', { hour12: false }),
    cursors: document.querySelectorAll('.streaming').length,
    runbar: !hidden,
    barText: hidden ? null : (document.querySelector('#runbar-text') || {}).textContent,
    barTime: hidden ? null : (document.querySelector('#runbar-time') || {}).textContent,
    msgs: document.querySelectorAll('.msg-a').length,
    len: (document.querySelector('#messages') || { innerText: '' }).innerText.length,
    notes: [...document.querySelectorAll('.sysnote')].slice(-2).map((e) => e.innerText.slice(0, 90)),
  };
});

// ---------------- R1: fin natural ----------------
const P1 = await mk();
await P1.req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'r1', version: '1' } });
const s1 = await P1.req('session/new', { cwd: cfg.cwd, mcpServers: [] });
await P1.req('_aegis/unstable/session/rename', { sessionId: s1.sessionId, title: 'zz fin natural v2' }).catch(() => {});
out.r1.sid = s1.sessionId;
const t1 = Date.now();
const p1run = P1.req('session/prompt', { sessionId: s1.sessionId, prompt: [{ type: 'text', text: 'Escribí exactamente este párrafo y nada más: "El mate es una infusión tradicional rioplatense. Se prepara cebando agua caliente sobre la yerba. Cada ronda se comparte entre todos." Después ejecutá la herramienta de shell con: powershell -NoProfile -Command "Start-Sleep -Seconds 25". Después de eso respondé exactamente: FIN-R1' }] })
  .then((r) => { out.r1.probe.push(['END_TURN', ((Date.now() - t1) / 1000).toFixed(0) + 's', r.stopReason, 'tools=' + P1.st.tools]); })
  .catch((e) => { out.r1.probe.push(['ERR', String(e.raw || e.message).slice(0, 200)]); });

await new Promise((r) => setTimeout(r, 6500));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
await p.evaluate((sid) => localStorage.setItem('gweb.last', sid), s1.sessionId);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(4500);
out.r1.join = await snap(p);

// sondeo directo (forma del error con run activo)
try {
  const P2 = await mk();
  await P2.req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'pm', version: '1' } });
  try {
    const rr = await P2.req('_aegis/unstable/session/steer', { sessionId: s1.sessionId, prompt: [{ type: 'text', text: '.' }], expectedRunId: 'probeZZZ' });
    out.r1.mismatch = { ok: true, result: rr };
  } catch (e) { out.r1.mismatch = { ok: false, raw: e.raw }; }
  P2.ws.close();
} catch (e) { out.r1.mismatch = { err: String(e).slice(0, 200) }; }

// muestreo
let endAt = null;
for (let i = 0; i < 44; i++) {
  await p.waitForTimeout(2500);
  const sn = await snap(p);
  out.r1.timeline.push(sn);
  if (!endAt && out.r1.probe.length) endAt = Date.now();
  if (endAt && Date.now() - endAt > 20000) break;
}
await p1run.catch(() => {});
out.r1.ultimas = out.r1.timeline.slice(-8);
await p.close();

// ---------------- R2: cancel desde adoptado ----------------
const P3 = await mk();
await P3.req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'r2', version: '1' } });
const s2 = await P3.req('session/new', { cwd: cfg.cwd, mcpServers: [] });
await P3.req('_aegis/unstable/session/rename', { sessionId: s2.sessionId, title: 'zz cancel adoptado v2' }).catch(() => {});
out.r2.sid = s2.sessionId;
const t2 = Date.now();
const p2run = P3.req('session/prompt', { sessionId: s2.sessionId, prompt: [{ type: 'text', text: 'Escribí la palabra PROBANDO y después ejecutá la herramienta de shell con: powershell -NoProfile -Command "Start-Sleep -Seconds 90". Después respondé: NO-DEBERIA-CORTE' }] })
  .then((r) => { out.r2.probe.push(['END', ((Date.now() - t2) / 1000).toFixed(0) + 's', r.stopReason, 'tools=' + P3.st.tools]); })
  .catch((e) => { out.r2.probe.push(['ERR', String(e.raw || e.message).slice(0, 200), 'tools=' + P3.st.tools]); });

await new Promise((r) => setTimeout(r, 6000));
const p2 = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await p2.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
await p2.evaluate((sid) => localStorage.setItem('gweb.last', sid), s2.sessionId);
await p2.reload({ waitUntil: 'domcontentloaded' });
await p2.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
await p2.waitForTimeout(4500);
out.r2.join = await snap(p2);
const btn = p2.locator('#runbar-stop');
if ((await btn.count()) && (await btn.isVisible())) { await btn.click(); out.r2.click = 'Detener clickeado'; }
else {
  const alt = p2.locator('#btn-stop');
  if ((await alt.count()) && (await alt.isVisible())) { await alt.click(); out.r2.click = 'btn-stop (composer) clickeado'; }
  else out.r2.click = 'sin boton visible';
}
for (let i = 0; i < 30; i++) {
  await p2.waitForTimeout(3000);
  const sn = await snap(p2);
  out.r2.timeline.push(sn);
  if (out.r2.probe.length) break;
  if (Date.now() - t2 > 120000) break;
}
await p2run.catch(() => {});
out.r2.ultimas = out.r2.timeline.slice(-6);
await p2.close();
await b.close();

// limpieza
for (const [P, sid] of [[P1, s1.sessionId], [P3, s2.sessionId]]) {
  try { await P.req('session/delete', { sessionId: sid }); out['limp_' + sid.slice(-6)] = 'ok'; }
  catch (e) { out['limp_' + sid.slice(-6)] = 'falló: ' + String(e.raw || e.message).slice(0, 90); }
  P.ws.close();
}
console.log(JSON.stringify(out, null, 1));
process.exit(0);
