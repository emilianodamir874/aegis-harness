// Prueba: cambiar de chat con turno en curso (fix detach). Fase adoptada + fase owner.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
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
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'switch-check', version: '1' } });
const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
await req('_aegis/unstable/session/rename', { sessionId: s.sessionId, title: 'zz switch test' }).catch(() => {});
out.sid = s.sessionId;
const p1 = req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Escribí una línea corta. Después ejecutá shell: powershell -NoProfile -Command "Start-Sleep -Seconds 40". Después respondé exactamente: FIN-SWITCH' }] })
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
  cursors: document.querySelectorAll('.streaming').length,
  len: (document.querySelector('#messages') || { innerText: '' }).innerText.length,
  hasFinSwitch: /FIN-SWITCH/.test((document.querySelector('#messages') || { innerText: '' }).innerText || ''),
  hasFinOwner: /FIN-OWNER/.test((document.querySelector('#messages') || { innerText: '' }).innerText || ''),
  notes: [...document.querySelectorAll('.sysnote')].slice(-3).map((e) => e.innerText.slice(0, 80)),
  ver: (document.querySelector('#meta-right') || {}).textContent || null,
}));

out.p1 = await snap(); out.pasos.push(['1-adoptado-en-test', out.p1]);

const otro = p.locator('.sb-item', { hasText: 'Historia del pan' }).first();
const vuelta = p.locator('.sb-item', { hasText: 'zz switch test' }).first();

// FASE 1: cambiar al otro chat con el run adoptado activo
await otro.click(); await p.waitForTimeout(3500);
out.p2 = await snap(); out.pasos.push(['2-otro-chat', out.p2]);
out.cambioPermitido = !(out.p2.notes || []).some((n) => /Esperá a que termine/.test(n));

let contaminado = false;
for (let i = 0; i < 8; i++) { await p.waitForTimeout(1500); const st = await snap(); if (st.hasFinSwitch || st.cursors > 0) contaminado = true; }
out.contaminado = contaminado;

// FASE 2: volver al test (debe re-adoptar)
await vuelta.click(); await p.waitForTimeout(4500);
out.p3 = await snap(); out.pasos.push(['3-vuelta-readopta', out.p3]);
await p1.catch(() => {});
await p.waitForTimeout(9000);
out.p4 = await snap(); out.pasos.push(['4-post-run', out.p4]);

// FASE 3: prompt propio (owner) y cambio inmediato
await p.fill('#input', 'Contá del 1 al 5 en una línea y respondé FIN-OWNER.');
await p.click('#btn-send');
await p.waitForTimeout(2500);
out.p5 = await snap(); out.pasos.push(['5-owner-enviado', out.p5]);
await otro.click(); await p.waitForTimeout(3000);
out.p6 = await snap(); out.pasos.push(['6-owner-cambio', out.p6]);
out.ownerCambioPermitido = !(out.p6.notes || []).some((n) => /Esperá a que termine/.test(n));
await p.waitForTimeout(16000);
out.p7 = await snap(); out.pasos.push(['7-otro-tras-owner', out.p7]);
await vuelta.click(); await p.waitForTimeout(5000);
out.p8 = await snap(); out.pasos.push(['8-vuelta-final', out.p8]);

await b.close();
try { await req('session/delete', { sessionId: s.sessionId }); out.limpieza = 'ok'; } catch (e) { out.limpieza = String(e).slice(0, 100); }
ws.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
