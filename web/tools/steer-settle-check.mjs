// Pedido 2 — verificación: un steer que el turno NO llega a consumir (se cancela justo después)
// debe reencolarse como mensaje normal al terminar, con aviso en la UI.
// Flujo: la pestaña arranca el turno (dueña del run) -> manda la indicación -> Detener
// inmediatamente -> el server descarta la indicación -> el cliente la reenvía como mensaje.
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const acpUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const out = {};
const stage = (k, v) => console.log('STAGE ' + k + ' ' + JSON.stringify(v));
let id = 0;
const pend = new Map();
const ws = new WebSocket(acpUrl);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined) { const f = pend.get(m.id); if (f) { f(m); pend.delete(m.id); } }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params, ms = 60000) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 160))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rej(new Error('timeout ' + ms)); } }, ms); });
await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name: 'steer-check', version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });

const br = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Safari/537.36' });
const page = await ctx.newPage();
const snap = () => page.evaluate(() => ({
  busy: window.__aegisWeb.state.busy,
  queue: window.__aegisWeb.state.queue.length,
  steers: [...window.__aegisWeb.__steersDbg ? [] : []].length,
  queued: [...document.querySelectorAll('.msg-user.queued')].map((e) => e.textContent.trim().slice(0, 60)),
  userMsgs: [...document.querySelectorAll('.msg-user')].map((e) => e.textContent.trim().slice(0, 60)),
  steerNotes: [...document.querySelectorAll('.steer-note')].map((e) => e.textContent),
  sysnotes: [...document.querySelectorAll('.sysnote')].map((e) => e.textContent).slice(-3),
  runbar: (() => { const x = document.querySelector('#runbar'); return !x || x.hidden ? null : x.querySelector('#runbar-text').textContent; })(),
}));
const marca = 'MARCATEST ' + Date.now().toString().slice(-5);
out.marca = marca;
try {
  await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 60000 });
  await page.evaluate(() => document.querySelector('#btn-new').click());
  await page.waitForTimeout(2500);
  const PASOS = 3, SEGS = 20;
  await page.evaluate(async ({ PASOS, SEGS }) => {
    const t = document.querySelector('#input');
    t.value = `Ejecutá con shell, en orden, estos ${PASOS} comandos: ` + Array.from({ length: PASOS }, (_, i) => `(paso ${i + 1}) powershell -NoProfile -Command "Start-Sleep -Seconds ${SEGS}; Write-Output PASO-${i + 1}"`).join(' ; ') + `. Al terminar respondé: FIN.`;
    t.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#btn-send').click();
  }, { PASOS, SEGS });
  await page.waitForFunction(() => window.__aegisWeb.state.busy, null, { timeout: 30000 });
  out.sid = await page.evaluate(() => window.__aegisWeb.state.current.id);
  await page.waitForTimeout(6000); // que el run esté haciendo herramientas
  out.antesDelSteer = await snap();

  // indicación mientras trabaja
  await page.evaluate((m) => { const t = document.querySelector('#input'); t.value = m + ': avisá que la recibiste'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#btn-send').click(); }, marca);
  await page.waitForTimeout(1800);
  out.trasSteer = await snap();
  stage('trasSteer', out.trasSteer);

  // Detener enseguida (el turno no va a consumir la indicación)
  await page.evaluate(() => document.querySelector('#btn-stop')?.click());
  out.detenerMs = await page.waitForFunction(() => !window.__aegisWeb.state.busy, null, { timeout: 30000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(1500);
  out.trasDetener = await snap();
  stage('trasDetener', out.trasDetener);

  // espera del asentamiento (2,5 s) + reenvío
  await page.waitForTimeout(7000);
  out.settled = await snap();
  stage('settled', out.settled);
  out.reenviado = { sysnote: out.settled.sysnotes.some((s) => /reenv/i.test(s)), burbuja: out.settled.userMsgs.some((u) => u.includes(marca)), turnoNuevo: out.settled.busy };

  // ¿quedó persistido en el server? (el reenvío debe estar en la conversación)
  await page.waitForTimeout(4000);
  const hist = [];
  const ws2 = new WebSocket(acpUrl);
  await new Promise((r) => ws2.addEventListener('open', r));
  let id2 = 10000;
  const p2 = new Map();
  ws2.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'session/update') {
      const u = m.params.update || {};
      if (u.sessionUpdate === 'user_message_chunk' && u.content && u.content.text) hist.push(u.content.text.slice(0, 80));
    }
    if (m.id !== undefined && m.method === undefined) { const f = p2.get(m.id); if (f) { f(m); p2.delete(m.id); } }
  });
  const req2 = (method, params) => new Promise((res, rej) => { const mid = ++id2; p2.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 120))) : res(m.result))); ws2.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
  await req2('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name: 'hist', version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });
  await req2('session/load', { sessionId: out.sid, cwd: cfg.cwd, mcpServers: [] }).catch(() => {});
  out.enServidor = hist.some((t) => t.includes(marca));
  out.userMsgsServidor = hist.length;
  stage('historial', { userMsgs: hist.length, contieneMarca: out.enServidor });
  ws2.close();
  await page.screenshot({ path: 'C:/Aegis-Proyects/web/tools/shots/steer-settle-mobile.png' });
} catch (e) { out.fatal = String((e && e.message) || e).slice(0, 300); }
try { await page.evaluate(() => document.querySelector('#btn-stop')?.click()); } catch {}
if (out.sid) await req('session/delete', { sessionId: out.sid }).catch(() => {});
ws.close();
await br.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
