// Prueba rigurosa del caso OWNER: mandás un mensaje (turno propio), cambiás de chat
// en medio (con run VIVO verificado desde afuera), volvés, todo sano.
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
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message || 'rpc'), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'owner-switch', version: '1' } });

const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2500);

// nuevo chat + prompt con sleep 30 (owner)
await p.click('#btn-new');
await p.waitForTimeout(1800);
const sid = await p.evaluate(() => localStorage.getItem('gweb.last'));
out.sid = sid;
await p.fill('#input', 'Ejecutá shell: powershell -NoProfile -Command "Start-Sleep -Seconds 30". Después respondé exactamente: FIN-OWNER2');
await p.click('#btn-send');
await p.waitForTimeout(3000);
const snap = () => p.evaluate(() => ({
  runbar: !!(document.querySelector('#runbar') && !document.querySelector('#runbar').hidden),
  barText: (document.querySelector('#runbar-text') || {}).textContent || null,
  cursors: document.querySelectorAll('.streaming').length,
  len: (document.querySelector('#messages') || { innerText: '' }).innerText.length,
  hasFin: /FIN-OWNER2/.test((document.querySelector('#messages') || { innerText: '' }).innerText || ''),
  notes: [...document.querySelectorAll('.sysnote')].slice(-2).map((e) => e.innerText.slice(0, 80)),
}));
out.p1 = await snap(); out.pasos.push(['1-owner-trabajando', out.p1]);

// cambiar a otro chat EN MEDIO
const otro = p.locator('.sb-item', { hasText: 'Historia del pan' }).first();
await otro.click();
await p.waitForTimeout(3000);
out.p2 = await snap(); out.pasos.push(['2-otro-chat', out.p2]);
out.cambioPermitido = !(out.p2.notes || []).some((n) => /Esperá a que termine/.test(n));

// desde afuera: el run sigue VIVO?
try {
  await req('_aegis/unstable/session/steer', { sessionId: sid, prompt: [{ type: 'text', text: '.' }], expectedRunId: 'probeZZ' });
  out.runVivo = null;
} catch (e) {
  const d = e.raw && e.raw.data;
  out.runVivo = !!(d && typeof d === 'object' && d.actualRunId) ? d.actualRunId : false;
}

// esperar a que termine (30s sleep + margen) estando en el otro chat
await p.waitForTimeout(32000);
const p3 = await snap(); out.pasos.push(['3-otro-tras-owner', p3]);
out.limpioMientrasCorria = !p3.hasFin;

// volver
const vuelta = p.locator('.sb-item', { hasText: 'zz owner' }).first();
let sel = vuelta;
if (!(await sel.count())) {
  // por si el título automático cambió: usar gweb? clic en el primer item con nuestro sid
  sel = p.locator('.sb-item').first();
}
await sel.click().catch(() => {});
await p.waitForTimeout(5000);
out.p4 = await snap(); out.pasos.push(['4-vuelta', out.p4]);

await b.close();
try { await req('session/delete', { sessionId: sid }); out.limpieza = 'ok'; } catch (e) { out.limpieza = String(e).slice(0, 80); }
ws.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
