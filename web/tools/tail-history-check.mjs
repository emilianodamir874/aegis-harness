// Comprueba el truncamiento informado por el servidor y la recuperación del historial.
// Reusa una sesión histórica existente: no envía prompts ni crea sesiones.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const base = (process.argv[2] || 'http://127.0.0.1:3788').replace(/\/+$/, '');
const password = JSON.parse(readFileSync('C:/Aegis-Proyects/web/auth.json', 'utf8')).password;
const browser = await chromium.launch();
let fail = 0;
const check = (name, ok, detail = '') => { console.log((ok ? 'OK   ' : 'FAIL ') + name + ' ' + detail); if (!ok) fail++; };
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.request.post(base + '/login', { form: { password }, maxRedirects: 0 });
  const page = await ctx.newPage();
  page.on('pageerror', e => check('sin error de página', false, e.message));
  const replayRequests = [];
  const replayResponses = [];
  page.on('websocket', ws => {
    ws.on('framesent', frame => {
      try { const p = JSON.parse(String(frame.payload)); if (p.method === 'session/load') replayRequests.push({ id: p.id, params: p.params }); } catch {}
    });
    ws.on('framereceived', frame => {
      try { const p = JSON.parse(String(frame.payload)); if (replayRequests.some(req => req.id === p.id)) replayResponses.push(p); } catch {}
    });
  });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__aegisWeb?.rpc?.ready && window.__aegisWeb?.state?.sessions?.length, null, { timeout: 20000 });
  const target = await page.evaluate(() => window.__aegisWeb.state.sessions.find(s => s._meta?.messageCount > 900 && !window.__aegisWeb.state.runningIds?.has(s.sessionId))?.sessionId);
  if (!target) throw new Error('No hay sesión histórica inactiva >900 mensajes en la lista actual');
  await page.locator(`.sb-row[data-id="${target}"] .sb-item`).click();
  await page.waitForFunction(sid => window.__aegisWeb.state.current?.id === sid && !window.__aegisWeb.state.replaying && document.querySelector('#tail-full'), target, { timeout: 15000 });
  const before = await page.evaluate(() => ({ pill: document.querySelector('#tail-pill')?.textContent,
    initial: window.__aegisWeb.state.msgs.size, scrolled: document.querySelector('#messages').scrollTop }));
  check('sesión histórica reconoce historial omitido', /\d+ mensajes anteriores no se cargaron/.test(before.pill || '') && before.initial < 400, JSON.stringify(before));
  await page.locator('#tail-full').click();
  await page.waitForFunction(() => !document.querySelector('#tail-pill') && !window.__aegisWeb.state.replaying && !window.__aegisWeb.state.replayBuf, null, { timeout: 60000 });
  const after = await page.evaluate(() => ({ count: window.__aegisWeb.state.msgs.size, pill: !!document.querySelector('#tail-pill'),
    nodes: document.querySelectorAll('#msg-inner > .msg-user, #msg-inner > .msg-a, #msg-inner > .tool').length }));
  check('full replay pedido con metadata ACP', replayRequests.length >= 2 && replayRequests[0].params?._meta?.replayTail === 400 && replayRequests[1].params?._meta?.replayTail === 1_000_000_000, JSON.stringify(replayRequests.map(r => r.params?._meta)));
  const skipped = Number(replayResponses[0]?.result?._meta?.replaySkipped ?? 0);
  check('cantidad visible coincide con el backend', skipped > 0 && before.pill.startsWith(skipped.toLocaleString('es-AR') + ' mensajes'), String(skipped));
  check('historial recuperado, sin pastilla', after.count > before.initial && !after.pill && after.nodes > 0, JSON.stringify(after));
  await ctx.close();
} finally { await browser.close(); }
console.log(fail ? `${fail} fallas` : 'PASS: historial completo recuperable');
process.exitCode = fail ? 1 : 0;
