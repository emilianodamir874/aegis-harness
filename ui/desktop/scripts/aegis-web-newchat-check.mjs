// Prueba: crear un NUEVO CHAT con un turno activo en el chat actual.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
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
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 150))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'newchat-check', version: '1' } });
const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
await req('_aegis/unstable/session/rename', { sessionId: s.sessionId, title: 'zz newchat test' }).catch(() => {});
out.sidA = s.sessionId;
const p1 = req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Escribí una línea. Después ejecutá shell: powershell -NoProfile -Command "Start-Sleep -Seconds 35". Después respondé exactamente: FIN-NEWCHAT' }] })
  .then((r) => { out.runEnd = r && r.stopReason; }).catch((e) => { out.runErr = String(e).slice(0, 120); });

await new Promise((r) => setTimeout(r, 4000));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
await p.evaluate((sid) => localStorage.setItem('gweb.last', sid), s.sessionId);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
await p.waitForFunction(() => document.querySelectorAll('.sb-item').length > 0, null, { timeout: 20000 }).catch(() => {});
await p.waitForTimeout(5500);
const snap = () => p.evaluate(() => ({
  runbar: !!(document.querySelector('#runbar') && !document.querySelector('#runbar').hidden),
  barText: (document.querySelector('#runbar-text') || {}).textContent || null,
  len: (document.querySelector('#messages') || { innerText: '' }).innerText.length,
  hasFin: /FIN-NEWCHAT/.test((document.querySelector('#messages') || { innerText: '' }).innerText || ''),
  welcome: !!document.querySelector('.welcome, #welcome'),
  notes: [...document.querySelectorAll('.sysnote')].slice(-3).map((e) => e.innerText.slice(0, 90)),
  last: localStorage.getItem('gweb.last'),
}));

out.p1 = await snap(); out.pasos.push(['1-adoptado', out.p1]);

// click + Nuevo chat
await p.click('#btn-new');
await p.waitForTimeout(4000);
out.p2 = await snap(); out.pasos.push(['2-nuevo-chat', out.p2]);
out.nuevoOK = !(out.p2.notes || []).some((n) => /Esperá a que termine/.test(n));
out.sidNuevo = out.p2.last;
out.nuevoEsOtro = out.p2.last && out.p2.last !== s.sessionId;

// A sigue activo?
try {
  await req('_aegis/unstable/session/steer', { sessionId: s.sessionId, prompt: [{ type: 'text', text: '.' }], expectedRunId: 'probe' + Math.random().toString(36).slice(2) });
  out.aActivo = false;
} catch (e) {
  const d = e.raw && e.raw.data;
  out.aActivo = !!(d && typeof d === 'object' && d.actualRunId);
}

// volver a A
const vuelta = p.locator('.sb-item', { hasText: 'zz newchat test' }).first();
await vuelta.click(); await p.waitForTimeout(4500);
out.p3 = await snap(); out.pasos.push(['3-vuelta-a-a', out.p3]);
await p1.catch(() => {});
await p.waitForTimeout(8000);
out.p4 = await snap(); out.pasos.push(['4-post-run', out.p4]);

await b.close();
for (const sid of [s.sessionId, out.sidNuevo]) {
  if (sid) { try { await req('session/delete', { sessionId: sid }); } catch {} }
}
out.limpieza = 'ok';
ws.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
