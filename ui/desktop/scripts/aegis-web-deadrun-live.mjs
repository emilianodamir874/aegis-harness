// 1) Busca en las sesiones recientes una herramienta que quedó SIN resultado (run muerto en
//    silencio: última actualización pending/in_progress) y verifica que el replay la marca
//    como interrumpida (no gira para siempre).
// 2) Verifica el refresco suave del turno adoptado con un run que SÍ produce mensajes nuevos
//    (texto en streaming): la pestaña recargada debe empezar a ver avances sola.
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const acpUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const out = {};
const stage = (k, v) => console.log('STAGE ' + k + ' ' + JSON.stringify(v));
let id = 0;
const pend = new Map();
let runId = null;
const seen = { pending: new Map() };
const ws = new WebSocket(acpUrl);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined) { const f = pend.get(m.id); if (f) { f(m); pend.delete(m.id); } return; }
  if (m.method === 'session/request_permission') {
    const opt = (m.params.options || [])[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
    return;
  }
  if (m.method === 'session/update') {
    const u = (m.params && m.params.update) || {};
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const tcid = u.toolCallId || u.id || '';
      if (tcid) seen.pending.set(tcid, { status: u.status || 'pending', title: (u.title || u.kind || '').slice(0, 60) });
    }
    const meta = u._meta;
    if (meta && meta.aegis && meta.aegis.activeRunId) runId = meta.aegis.activeRunId;
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params, ms = 120000) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 160))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rej(new Error('timeout ' + ms + 'ms en ' + method)); } }, ms); });
await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name: 'dead-run-check', version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });

// ---------- 1) buscar sesiones con herramientas sin resultado ----------
const list = await req('session/list', {});
const recientes = (list.sessions || []).slice().sort((a, b) => String((b._meta && b._meta.lastMessageAt) || '').localeCompare(String((a._meta && a._meta.lastMessageAt) || ''))).slice(0, 8);
out.escaneadas = [];
for (const s of recientes) {
  seen.pending.clear();
  try { await req('session/load', { sessionId: s.sessionId, cwd: s.cwd || cfg.cwd, mcpServers: [] }); } catch (e) { out.escaneadas.push({ id: s.sessionId, err: String(e.message).slice(0, 60) }); continue; }
  const colgadas = [...seen.pending.values()].filter((t) => t.status === 'pending' || t.status === 'in_progress');
  out.escaneadas.push({ id: s.sessionId, msgs: (s._meta && s._meta.messageCount) || 0, lastMessageAt: s._meta && s._meta.lastMessageAt, tools: seen.pending.size, colgadas: colgadas.length, ejemplos: colgadas.slice(0, 2) });
  stage('scan', { id: s.sessionId, msgs: (s._meta && s._meta.messageCount) || 0, colgadas: colgadas.length });
}
const conColgadas = out.escaneadas.filter((x) => x.colgadas > 0).sort((a, b) => b.colgadas - a.colgadas)[0];
out.elegida = conColgadas || null;

const br = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Safari/537.36' });
const page = await ctx.newPage();
try { await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 }); } catch {}

try {
  // ---------- 1b) replay de esa sesión en el navegador: ¿se marca interrumpida? ----------
  if (conColgadas) {
    await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 60000 });
    await page.evaluate((sid) => localStorage.setItem('gweb.last', sid), conColgadas.id);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state.current && window.__aegisWeb.state.current.id === localStorage.getItem('gweb.last'), null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(6000);
    out.replayColgadas = await page.evaluate(() => ({
      tools: document.querySelectorAll('#msg-inner .tool').length,
      girando: document.querySelectorAll('#msg-inner .tool .spin').length,
      marcadas: [...document.querySelectorAll('#msg-inner .tool')].filter((e) => e.classList.contains('err') && e.querySelector('.tint')).length,
      ejemplo: (() => { const e = [...document.querySelectorAll('#msg-inner .tool')].find((x) => x.querySelector('.tint')); return e ? e.querySelector('.tool-title').textContent.trim().slice(0, 100) : null; })(),
    }));
    stage('replay-marca', out.replayColgadas);
    await page.screenshot({ path: 'C:/goose-web/tools/shots/interrumpidas-mobile.png' });
  }

  // ---------- 2) turno adoptado que produce mensajes nuevos ----------
  const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
  const sid = s.sessionId;
  out.sid2 = sid;
  const PASOS = 12, SEGS = 4;
  const promptText = `Primero corré con shell, en orden, estos ${PASOS} comandos: ` + Array.from({ length: PASOS }, (_, i) => `(paso ${i + 1}) powershell -NoProfile -Command "Start-Sleep -Seconds ${SEGS}; Write-Output PASO-${i + 1}"`).join(' ; ') + `. Y cuando terminen, escribí tres párrafos de 120 palabras cada uno sobre molinos de viento.`;
  const promptP = req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: promptText }] }).then((r) => (out.prompt2 = { stopReason: (r && r.stopReason) || null })).catch((e) => (out.promptErr2 = String(e).slice(0, 160)));
  for (let i = 0; i < 80 && !runId; i++) await new Promise((r) => setTimeout(r, 250));
  out.runId2 = runId;
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((sid) => localStorage.setItem('gweb.last', sid), sid);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__aegisWeb?.state.busy && window.__aegisWeb.state.adopted, null, { timeout: 30000 }).catch(() => {});
  out.adoptMs2 = Date.now() - t0;
  const dom0 = await page.evaluate(() => ({ nodes: document.querySelectorAll('#msg-inner *').length, msgs: document.querySelectorAll('.msg-a,.msg-user,.tool').length }));
  await page.waitForTimeout(35000); // en reposo: los refrescos suaves deben traer lo nuevo
  const dom1 = await page.evaluate(() => ({ nodes: document.querySelectorAll('#msg-inner *').length, msgs: document.querySelectorAll('.msg-a,.msg-user,.tool').length }));
  out.live = {
    domAntes: dom0, domDespues: dom1, crecio: dom1.msgs > dom0.msgs || dom1.nodes > dom0.nodes,
    watch: await page.evaluate(() => ({ ticks: window.__aegisWeb.watchDbg.ticks, softResyncs: window.__aegisWeb.watchDbg.softResyncs, softMs: Math.round(window.__aegisWeb.watchDbg.softMs), maxSoftMs: Math.round(window.__aegisWeb.watchDbg.maxSoftMs), lastSoft: window.__aegisWeb.watchDbg.lastSoft, deferred: window.__aegisWeb.watchDbg.softDeferred })),
    ultimoTexto: await page.evaluate(() => (document.querySelectorAll('.msg-a .content').length ? document.querySelectorAll('.msg-a .content')[document.querySelectorAll('.msg-a .content').length - 1].textContent.slice(-120) : null)),
    runbar: await page.evaluate(() => { const x = document.querySelector('#runbar'); return !x || x.hidden ? null : { text: x.querySelector('#runbar-text').textContent, time: x.querySelector('#runbar-time').textContent, stop: !x.querySelector('#runbar-stop').hidden }; }),
  };
  stage('live-adoptado', out.live);
  await page.screenshot({ path: 'C:/goose-web/tools/shots/live-adoptado-mobile.png' });
  await page.evaluate(() => document.querySelector('#runbar-stop')?.click());
  await page.waitForFunction(() => !window.__aegisWeb.state.busy, null, { timeout: 30000 }).catch(() => {});
  await Promise.race([promptP, new Promise((r) => setTimeout(r, 20000))]);
  await req('session/delete', { sessionId: sid }).catch(() => {});
} catch (e) { out.fatal = String((e && e.message) || e).slice(0, 300); }
ws.close();
await br.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
