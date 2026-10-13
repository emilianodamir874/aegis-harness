// Verificación determinista de la adopción del turno al recargar (no depende del modelo):
//  1) conexión ACP cruda: session/new + prompt (arranca un run de verdad)
//  2) espera el session_info_update con activeRunId en esa conexión
//  3) el navegador (390x844) abre la app con esa sesión y RECARGA en medio del turno
//  4) asserts: barra de turno + Detener + busy + runId correcto, sin recargar a mano
//  5) Detener desde la pestaña recargada (session/cancel va al dueño del run)
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const out = {};
let id = 0;
const pend = new Map();
let activeRunId = null;
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'session/request_permission') {
    const opt = (m.params.options || [])[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
    return;
  }
  const meta = m.params && m.params.update && m.params.update._meta;
  if (meta && meta.goose && meta.goose.activeRunId) activeRunId = meta.goose.activeRunId;
});
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { goose: { customNotifications: true } } }, clientInfo: { name: 'adopt-check', version: '1' }, _meta: { 'goose/useLoginShellPath': true } });
const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
const sid = s.sessionId;
out.sid = sid;
const promptP = req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Ejecutá con la herramienta de shell exactamente: powershell -NoProfile -Command "Start-Sleep -Seconds 25; Write-Output FIN-ADOPT". Después respondé: LISTO-ADOPT' }] }).catch((e) => (out.promptErr = String(e).slice(0, 160)));

for (let i = 0; i < 60 && !activeRunId; i++) await new Promise((r) => setTimeout(r, 250));
out.runId = activeRunId;
if (!activeRunId) { console.log(JSON.stringify({ fatal: 'no arranco el run (el modelo no uso el tool?)', ...out })); process.exit(0); }

const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Safari/537.36' });
const page = await ctx.newPage();
const snap = () => page.evaluate(() => ({
  busy: window.__gooseWeb.state.busy,
  adopted: window.__gooseWeb.state.adopted,
  runId: window.__gooseWeb.state.runId,
  runbar: (() => { const x = document.querySelector('#runbar'); return !x || x.hidden ? null : { text: x.querySelector('#runbar-text').textContent, time: x.querySelector('#runbar-time').textContent, stopVisible: !x.querySelector('#runbar-stop').hidden }; })(),
  notes: [...document.querySelectorAll('.sysnote')].map((e) => e.textContent).slice(-2),
}));
try {
  await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 });
  await page.evaluate((sid) => localStorage.setItem('gweb.last', sid), sid);
  const t0 = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gooseWeb && window.__gooseWeb.state.current && window.__gooseWeb.state.current.id === (localStorage.getItem('gweb.last')), null, { timeout: 30000 }).catch(() => {});
  out.adoptMs = await page.waitForFunction(() => window.__gooseWeb.state.busy && window.__gooseWeb.state.adopted, null, { timeout: 20000 }).then(() => Date.now() - t0).catch(() => 'timeout-20s');
  out.trasRecarga = await snap();
  await page.waitForTimeout(3000);
  out.aLos3s = await snap();
  await page.screenshot({ path: 'C:/goose-web/tools/shots/adopt-mobile.png' });
  // Detener desde la pestaña recargada
  const ts = Date.now();
  await page.evaluate(() => document.querySelector('#runbar-stop')?.click());
  out.detenerMs = await page.waitForFunction(() => !window.__gooseWeb.state.busy, null, { timeout: 30000 }).then(() => Date.now() - ts).catch(() => 'timeout-30s');
  out.trasDetener = await snap();
} catch (e) { out.fatal = String((e && e.message) || e).slice(0, 300); }
await promptP;
out.trasPrompt = { runId: activeRunId, stopReason: out.promptErr || 'ok' };
await req('session/delete', { sessionId: sid }).catch(() => {});
ws.close();
await b.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
