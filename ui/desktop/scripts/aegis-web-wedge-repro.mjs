// Reproducción del flujo reportado: steer → cambio de chat → reload → volver → enviar otra vez.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const out = { pasos: [] };

let id = 0; const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'session/request_permission') {
    const opt = (m.params.options || []).find((o) => o.optionId === 'allow_once') || m.params.options[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message || 'rpc'), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'wedge-repro', version: '1' } });
const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
await req('_aegis/unstable/session/rename', { sessionId: s.sessionId, title: 'zz prueba wedge' }).catch(() => {});
out.sid = s.sessionId;
const p1 = req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Escribí tres líneas contando del 1 al 3. Después ejecutá shell: powershell -NoProfile -Command "Start-Sleep -Seconds 25". Después respondé FIN-WEDGE' }] })
  .then((r) => { out.runEnd = r && r.stopReason; }).catch((e) => { out.runErr = String(e).slice(0, 120); });

await new Promise((r) => setTimeout(r, 4000));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
await p.evaluate((sid) => localStorage.setItem('gweb.last', sid), s.sessionId);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
await p.waitForFunction(() => document.querySelectorAll('.sb-item').length > 0, null, { timeout: 20000 }).catch(() => {});
await p.waitForTimeout(5000);

const snap = () => p.evaluate(() => {
  const G = window.__aegisWeb || {};
  const st = G.state || {};
  return {
    busy: !!st.busy, adopted: !!st.adopted, cur: st.current && st.current.id, runId: st.runId || null,
    queue: (st.queue || []).length, steers: st.steers ? st.steers.size : null,
    pending: (G.pendingSteers ? (G.pendingSteers() || []).length : null),
    runbar: !!(document.querySelector('#runbar') && !document.querySelector('#runbar').hidden),
    barText: (document.querySelector('#runbar-text') || {}).textContent || null,
    len: (document.querySelector('#messages') || { innerText: '' }).innerText.length,
    notes: [...document.querySelectorAll('.sysnote')].slice(-3).map((e) => e.innerText.slice(0, 100)),
  };
});

out.p1 = await snap(); out.pasos.push(['1-adoptado-en-A', out.p1]);

// mensaje 1 al vuelo (steer) mientras corre
await p.fill('#input', 'mensaje intermedio de prueba');
await p.click('#btn-send');
await p.waitForTimeout(1600);
out.p2 = await snap(); out.pasos.push(['2-steer-enviado', out.p2]);

// cambiar de chat
const otro = p.locator('.sb-item', { hasText: 'Historia del pan' }).first();
await otro.click(); await p.waitForTimeout(2200);
out.p3 = await snap(); out.pasos.push(['3-cambio-a-otro', out.p3]);

// recargar (como hizo él)
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(3500);
out.p4 = await snap(); out.pasos.push(['4-tras-reload', out.p4]);

// volver a A (por gweb.last + reload, como al reabrir)
await p.evaluate((sid) => localStorage.setItem('gweb.last', sid), s.sessionId);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(4500);
out.p5 = await snap(); out.pasos.push(['5-vuelta-a-A', out.p5]);

// intento de envío Nº2
await p.fill('#input', 'segundo mensaje tras la vuelta');
await p.click('#btn-send');
await p.waitForTimeout(2500);
out.p6 = await snap(); out.pasos.push(['6-envio-2', out.p6]);
out.envio2Aceptado = out.p6.busy || out.p6.runbar; // si arrancó run, debería estar busy

// esperar fin del run y probar envío 3 (ya en estado normal)
await p1.catch(() => {});
await p.waitForTimeout(6000);
out.p7 = await snap(); out.pasos.push(['7-post-run1', out.p7]);
await p.fill('#input', 'tercer mensaje de control');
await p.click('#btn-send');
await p.waitForTimeout(6000);
out.p8 = await snap(); out.pasos.push(['8-envio-3', out.p8]);
out.textoVisible = await p.evaluate(() => document.querySelector('#messages').innerText.slice(-260));

await b.close();
try { await req('session/delete', { sessionId: s.sessionId }); out.limpieza = 'ok'; } catch (e) { out.limpieza = String(e).slice(0, 80); }
ws.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
