// Prueba en vivo del escenario exacto de Emiliano sobre la v5:
// turno largo → recargar la página en medio → ¿adopta el run (barra/Detener)?
// → mensaje durante el turno (¿cola o error?) → al terminar, ¿se envía solo?
// → y por último: ¿Detener corta un turno en curso?
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const out = { pasos: [] };
const b = await chromium.launch({ channel: 'chrome', headless: true });
let sid = null;
const shot = (n) => `C:/goose-web/tools/shots/reload-test-${n}.png`;

// En móvil el sidebar es un drawer: los clicks van por JS (fuera del viewport).
const clickIn = (pg, sel) => pg.evaluate((s) => document.querySelector(s)?.click(), sel);

const runbar = (p) => p.evaluate(() => {
  const bar = document.querySelector('#runbar');
  const stop = document.querySelector('#runbar-stop');
  const send = document.querySelector('#btn-send');
  return {
    runbar: !!(bar && !bar.hidden),
    runbarText: bar && !bar.hidden ? (bar.querySelector('#runbar-text') || {}).textContent : null,
    runbarTime: bar && !bar.hidden ? (bar.querySelector('#runbar-time') || {}).textContent : null,
    stopVisible: !!(stop && !stop.hidden),
    sendVisible: !!(send && !send.hidden),
    msgsLen: (document.querySelector('#messages') || {}).innerText ? document.querySelector('#messages').innerText.length : 0,
    busy: window.__gooseWeb.state.busy,
    runId: window.__gooseWeb.state.runId,
    adopted: window.__gooseWeb.state.adopted,
    queuedNotes: [...document.querySelectorAll('.steer-note')].map((e) => e.textContent).slice(-2),
    turnEnd: [...document.querySelectorAll('.turn-end')].map((e) => e.textContent).slice(-1),
    sysnotes: [...document.querySelectorAll('.sysnote')].map((e) => e.textContent).slice(-2),
  };
});

try {
  const MOBILE = process.argv.includes('--mobile'); // 390x844, como el telefono
  const ctx = await b.newContext(
    MOBILE
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36' }
      : { viewport: { width: 1600, height: 900 } }
  );
  const p = await ctx.newPage();
  p.on('pageerror', (e) => out.pasos.push({ err: String(e.message).slice(0, 160) }));
  await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 }).catch(() => {});
  await p.waitForFunction(() => document.querySelectorAll('.sb-item').length > 0, null, { timeout: 20000 }).catch(() => {});

  // buscar el sid de la sesión nueva que crearemos: lo sacamos del ACP aparte; usamos el título
  await clickIn(p, '#btn-new');
  await p.waitForTimeout(1800);
  sid = await p.evaluate(async () => {
    // leer el id actual desde localStorage (lo escribe la app al crear/abrir)
    return localStorage.getItem('gweb.last');
  });
  out.sid = sid;

  // 1) turno largo (~75s de shell)
  await p.fill('#input', 'Usá la herramienta de shell para ejecutar exactamente este comando y esperá a que termine: powershell -NoProfile -Command "Start-Sleep -Seconds 75; Write-Output FIN-LARGO". Después respondé exactamente: LISTO-FIN');
  await clickIn(p, '#btn-send');
  await p.waitForFunction(() => { const b = document.querySelector('#runbar'); return b && !b.hidden; }, null, { timeout: 30000 }).catch(() => {});
  out.pasos.push({ paso: '1-run-iniciado', ...(await runbar(p)) });
  await p.screenshot({ path: shot('1-run') });

  // 2) RECARGA en medio del turno
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 }).catch(() => {});
  await p.waitForTimeout(5000); // que cargue la sesión y adopte
  out.pasos.push({ paso: '2-tras-reload', ...(await runbar(p)) });
  await p.screenshot({ path: shot('2-reload') });
  const t1 = await runbar(p);
  await p.waitForTimeout(8000);
  const t2 = await runbar(p);
  out.pasos.push({ paso: '2b-adopta-sigue', ...t2, crecio: t2.msgsLen >= t1.msgsLen, timer: t2.runbarTime });

  // 3) mensaje DURANTE el turno (debería encolarse)
  await p.fill('#input', 'Mensaje de prueba enviado durante el turno');
  await clickIn(p, '#btn-send');
  await p.waitForTimeout(1200);
  out.pasos.push({
    paso: '3-mientras-busy',
    sysnotes: await p.locator('.sysnote').allTextContents().catch(() => []),
    queuedNotes: await p.evaluate(() => [...document.querySelectorAll('.queued, .msg-user.queued, [class*=queued]')].map((e) => e.innerText.slice(0, 120)).slice(0, 4)),
    ...(await runbar(p)),
  });
  await p.screenshot({ path: shot('3-queued') });

  // 4) esperar fin del turno (~90s) y ver si el encolado se envió solo + respondió
  await p.waitForFunction(() => { const b = document.querySelector('#runbar'); return !b || b.hidden; }, null, { timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(6000);
  const after = await p.evaluate(() => document.querySelector('#messages').innerText);
  out.pasos.push({
    paso: '4-fin-turno',
    seEnvioCola: /LISTO-FIN|Mensaje de prueba/.test(after),
    termino: /LISTO-FIN|FIN-LARGO|Detenido|terminó/.test(after),
    ...(await runbar(p)),
  });
  await p.screenshot({ path: shot('4-fin') });

  // 5) Detener: segundo turno largo y lo cortamos
  await p.fill('#input', 'Usá la herramienta de shell para ejecutar: powershell -NoProfile -Command "Start-Sleep -Seconds 90; Write-Output NO-DEBERIA". Después respondé: NO-DEBERIA');
  await clickIn(p, '#btn-send');
  await p.waitForFunction(() => { const b = document.querySelector('#runbar'); return b && !b.hidden; }, null, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(6000);
  const stopBtn = p.locator('#runbar-stop');
  if (await stopBtn.count()) {
    await clickIn(p, '#runbar-stop');
    out.pasos.push({ paso: '5-detener-click', ok: true });
  }
  await p.waitForFunction(() => { const b = document.querySelector('#runbar'); return !b || b.hidden; }, null, { timeout: 45000 }).catch(() => {});
  const afterStop = await p.evaluate(() => document.querySelector('#messages').innerText);
  out.pasos.push({
    paso: '5b-tras-detener',
    corto: /Detenid|detenid|cancel/i.test(afterStop),
    ...(await runbar(p)),
  });
  await p.screenshot({ path: shot('5-stop') });
  await ctx.close();
} catch (e) {
  out.fatal = String(e && e.stack ? e.stack : e).slice(0, 500);
} finally {
  await b.close();
}

// limpieza: borrar la sesión de prueba por ACP
if (sid) {
  try {
    const ws = new WebSocket(`ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`);
    await new Promise((res) => ws.addEventListener('open', res));
    let id = 0;
    const pend = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
    await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cleanup', version: '1' } });
    await req('session/delete', { sessionId: sid });
    out.limpieza = 'sesion borrada: ' + sid;
    ws.close();
  } catch (e) { out.limpieza = 'no se pudo borrar: ' + String(e).slice(0, 150); }
}
console.log(JSON.stringify(out, null, 1));
