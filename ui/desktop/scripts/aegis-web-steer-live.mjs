// A: ¿un mensaje escrito en una pestaña ADOPTADA, durante una herramienta SILENCIOSA larga,
// lo consume el agente en ese mismo turno (steer) en vez de perderse y reencolarse al final?
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
const WS = globalThis.WebSocket; // Node 22+ trae WebSocket global (no necesita el paquete `ws`)
const CFG = JSON.parse(readFileSync('C:/aegis-web/config.json', 'utf8'));
const URL = `ws://${CFG.publicHost}:${CFG.servePort}/acp?token=${CFG.secretKey}`;
const MARK = 'STEER-VIVO ' + Math.floor(Math.random() * 90000 + 10000);
const PASOS = 6, SEGS = 14; // ~84 s de herramientas silenciosas

function conn(tag) {
  const ws = new WS(URL);
  let id = 0; const pend = new Map(); const notes = [];
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id !== undefined && (m.result !== undefined || m.error)) { const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error).slice(0, 160))) : p.res(m.result); } return; }
    if (m.method === 'session/update' || m.method === '_aegis/unstable/session/update') notes.push(m.params?.update || m.params);
  };
  const ready = new Promise((r) => { ws.onopen = () => r(); });
  const req = (method, params) => new Promise((res, rej) => { const myId = ++id; pend.set(myId, { res, rej }); ws.send(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })); setTimeout(() => { if (pend.has(myId)) { pend.delete(myId); rej(new Error('timeout ' + method)); } }, 240000); });
  return { tag, ws, ready, req, notes, init: async () => req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name: tag, version: '1' } }) };
}
const out = { marca: MARK, pasos: [] };
const stage = (k, v) => { out.pasos.push({ k, ...v }); };

const owner = conn('owner'); await owner.ready; await owner.init();
const nw = await owner.req('session/new', { cwd: CFG.cwd, mcpServers: [] });
const sid = nw.sessionId;
stage('sesion', { sid });

const promptTxt = `Ejecutá exactamente ${PASOS} comandos shell en secuencia, uno por vez, sin texto entre ellos: \`powershell -Command "Start-Sleep -Seconds ${SEGS}; Write-Output paso"\`. Cuando termines los ${PASOS}, respondé sólo "LISTO".`;
const promptP = owner.req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: promptTxt }] }).catch((e) => ({ error: String(e.message).slice(0, 120) }));

// esperar a que arranque la primera herramienta (ventana silenciosa)
await new Promise((r) => { const t0 = Date.now(); const iv = setInterval(() => { if (owner.notes.some((n) => /tool|shell/i.test(JSON.stringify(n).slice(0, 400))) || Date.now() - t0 > 90000) { clearInterval(iv); r(); } }, 500); });
stage('tool-iniciada', { t: Date.now() });

const br = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)));
const clickIn = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);
await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await page.evaluate((s) => localStorage.setItem('gweb.last', s), sid);
const tAdopt = Date.now();
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__aegisWeb?.state?.adopted === true, null, { timeout: 90000 }).catch(() => {});
const snap = () => page.evaluate(() => ({
  busy: window.__aegisWeb.state.busy, adopted: window.__aegisWeb.state.adopted, runId: window.__aegisWeb.state.runId,
  runbar: document.querySelector('#runbar')?.hidden === false ? document.querySelector('#runbar-text')?.textContent : null,
  stop: document.querySelector('#runbar-stop')?.offsetParent !== null,
  steerNotes: [...document.querySelectorAll('.sysnote')].map((e) => e.textContent).filter((t) => /indicaci/i.test(t)),
  cola: window.__aegisWeb.state.queue.length, steers: window.__aegisWeb.state.steers.size, composerText: document.querySelector('#input').value,
  sysnotes: [...document.querySelectorAll('.sysnote')].map((e) => e.textContent),
}));
const a1 = await snap();
stage('adoptado', { ms: Date.now() - tAdopt, ...a1 });

// escribir y enviar DURANTE la herramienta silenciosa (la pestaña NO es dueña del run)
await page.evaluate((m) => { const ta = document.querySelector('#input'); ta.focus(); ta.value = m; ta.dispatchEvent(new Event('input', { bubbles: true })); }, MARK);
await page.waitForTimeout(400);
// con el turno en curso el botón #send está oculto: se manda con Enter
await page.evaluate((m) => { const ta = document.querySelector('#input'); ta.focus(); ta.value = m; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }, MARK);
await page.waitForTimeout(2500);
const a2 = await snap();
stage('tras-enviar', a2);
out.enCola = a2.steerNotes.length > 0;

// esperar el fin del turno (dueño) y ver quien consume la marca
const fin = await Promise.race([promptP, new Promise((r) => setTimeout(() => r({ error: 'espera-larga' }), 240000))]);
stage('fin-turno', { stopReason: fin?.stopReason || fin?.error || 'sin-respuesta' });
await page.waitForTimeout(4000);
const a3 = await snap();
stage('post-turno-ui', a3);
out.reencolada = a3.sysnotes.some((t) => /sin respuesta|se reenv/i.test(t));
out.siguienteTurno = a3.busy === true;

// ¿la marca quedó en el historial persistido y ANTES de una respuesta? (=> la consumió en el turno)
const v = conn('verify'); await v.ready; await v.init();
const loaded = await v.req('session/load', { sessionId: sid, cwd: CFG.cwd, mcpServers: [] }).catch(() => null);
await new Promise((r) => setTimeout(r, 2500));
const seq = v.notes.map((n) => ({ kind: n?.sessionUpdate || n?.type || Object.keys(n || {})[0], text: (n?.content?.text || n?.text || '') + '' }));
const texts = seq.filter((x) => x.kind === 'user_message_chunk' || /user/.test(x.kind || '')).map((x) => x.text);
const idxMarca = texts.findIndex((t) => t.includes(MARK));
const prefijo = seq.slice(0, idxMarca).map((x) => x.kind).join(',').slice(-200);
out.enServidor = idxMarca >= 0;
out.posicion = idxMarca >= 0 ? { userMsgs: texts.length, idx: idxMarca, esUltimoMensaje: idxMarca === texts.length - 1 } : null;
out.trasMarca = idxMarca >= 0 ? seq.slice(idxMarca + 1).map((x) => x.kind).slice(0, 6) : null;
out.consumida = out.enServidor && out.posicion && !out.posicion.esUltimoMensaje;
out.errores = errs;
await owner.req('session/delete', { sessionId: sid }).catch(() => {});
out.limpieza = 'sesion borrada: ' + sid;
const dest = process.argv[2] || 'C:/aegis-web/tools/steer-live.json';
writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await br.close(); owner.ws.close(); v.ws.close(); process.exit(0);
