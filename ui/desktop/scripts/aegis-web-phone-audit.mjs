// Auditoría de móvil (390×844) de aegis-web — reproduce y verifica el feedback de Emiliano:
//  A. header: ¿están TODOS los desplegables (chips) visibles y legibles?
//  B. composer: costo de tipear (tecla → frame pintado) en reposo, DURANTE el streaming,
//     y A/B del throttle de render (live=false lo desactiva = comportamiento previo).
//  C. turno: ¿se ve que trabaja? ¿Detener corta de verdad? ¿y si se cae el WS / se recarga?
// Uso: node scripts/aegis-web-phone-audit.mjs [url]
// Correr DESPRENDIDO (Start-Process + log): el wrapper de background mata node con stdin no-tty.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:3788/';
const shots = 'C:/aegis-web/tools/shots';
mkdirSync(shots, { recursive: true });

const out = { url, header: {}, idle: {}, streaming: {}, stop: {}, offline: {}, errors: [] };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const LONG_PROMPT = 'Escribí un ensayo de 900 palabras sobre la historia del pan, en párrafos seguidos (sin listas ni títulos). Empezá ya.';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
});
const page = await ctx.newPage();
page.on('pageerror', (e) => out.errors.push('pageerror: ' + String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') out.errors.push('console: ' + m.text().slice(0, 200)); });

const waitConn = () => page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 });
const clickInPage = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel); // el drawer móvil está fuera del viewport
const snapshot = () =>
  page.evaluate(() => ({
    busy: window.__aegisWeb.state.busy,
    runId: window.__aegisWeb.state.runId,
    stopVisible: !document.querySelector('#btn-stop').hidden,
    sendVisible: !document.querySelector('#btn-send').hidden,
    runbar: (() => {
      const b = document.querySelector('#runbar');
      return !b || b.hidden ? null : { text: (b.querySelector('#runbar-text').textContent || '').trim(), time: (b.querySelector('#runbar-time').textContent || '').trim(), done: b.classList.contains('done'), cancelling: b.classList.contains('cancelling'), stopVisible: !b.querySelector('#runbar-stop').hidden };
    })(),
    cursor: document.querySelectorAll('.msg-a.streaming').length,
    turnEnd: [...document.querySelectorAll('.turn-end')].map((e) => e.textContent).slice(-2),
    notes: [...document.querySelectorAll('.sysnote')].map((e) => e.textContent).slice(-3),
  }));

const measureHeader = () =>
  page.evaluate(() => {
    const vw = window.innerWidth;
    const chipsEl = document.querySelector('#chips');
    const opts = (window.__aegisWeb.state.current && window.__aegisWeb.state.current.configOptions) || [];
    const chips = [...chipsEl.querySelectorAll('.chip-wrap')].map((w) => {
      const b = w.querySelector('.chip');
      const r = b.getBoundingClientRect();
      return { opt: w.dataset.opt, label: (b.textContent || '').trim(), display: getComputedStyle(w).display, w: Math.round(r.width), fullyVisible: r.width > 0 && r.left >= -0.5 && r.right <= vw + 0.5, truncatedLabel: b.scrollWidth > b.clientWidth + 1 };
    });
    return {
      configOptions: opts.filter((o) => o.type === 'select' && (o.options || []).length > 1).map((o) => o.id),
      topbarH: Math.round(document.querySelector('.topbar').getBoundingClientRect().height),
      title: (document.querySelector('#chat-title').textContent || '').trim(),
      chipsBoxScrollable: chipsEl.scrollWidth > chipsEl.clientWidth + 1,
      chips,
      chipsShown: chips.filter((c) => c.display !== 'none').length,
      chipsFullyVisible: chips.filter((c) => c.display !== 'none' && c.fullyVisible && !c.truncatedLabel).length,
    };
  });

// Tecla → frame pintado (y cadencia de frames), con N teclas sintéticas espaciadas gapMs.
const measureTyping = (n = 30, gapMs = 25) =>
  page.evaluate(
    async ([n, gapMs]) => {
      const t = document.querySelector('#input');
      const msgs = document.querySelector('#messages');
      t.focus();
      t.value = '';
      await new Promise((r) => requestAnimationFrame(r));
      const lat = [];
      const frames = [];
      let last = performance.now();
      let on = true;
      const loop = (now) => { if (!on) return; frames.push(Math.round(now - last)); last = now; requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        t.value += 'q';
        t.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => requestAnimationFrame(r));
        lat.push(+(performance.now() - t0).toFixed(1));
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      }
      on = false;
      const p = (a, q) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * q) / 100))] || 0;
      return { keys: n, paintMs: { p50: p(lat, 50), p95: p(lat, 95), max: Math.max(...lat) }, frameMs: { p50: p(frames, 50), p95: p(frames, 95), max: Math.max(...frames), n: frames.length } };
    },
    [n, gapMs]
  );

// Fuerza el camino sin throttle (render en cada frame) mientras dura la ventana.
const forceUnthrottled = (ms) =>
  page.evaluate(async (ms) => {
    const st = window.__aegisWeb.state;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      for (const rec of new Set(st.msgs.values())) rec.live = false;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return true;
  }, ms);

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitConn();
  await page.waitForFunction(() => document.querySelectorAll('.sb-item').length > 0, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);

  // ---------- A. header en sesión real (con configOptions) ----------
  const big = await page.evaluate(() => {
    const s = window.__aegisWeb.state.sessions.slice().sort((a, b) => (b._meta?.messageCount || 0) - (a._meta?.messageCount || 0))[0];
    return s ? { id: s.sessionId, n: s._meta?.messageCount || 0 } : null;
  });
  out.bigSession = big;
  await page.evaluate((id) => document.querySelector(`.sb-row[data-id="${id}"] .sb-item`)?.click(), big.id);
  await page.waitForFunction(() => !document.querySelector('#status-pill'), null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1500);
  out.dom = await page.evaluate(() => ({ nodes: document.querySelectorAll('#msg-inner *').length, msgs: document.querySelectorAll('.msg-a, .msg-user, .tool').length }));
  out.header = await measureHeader();
  await page.screenshot({ path: shots + '/audit-phone-topbar.png', clip: { x: 0, y: 0, width: 390, height: 130 } });
  log('A header:', JSON.stringify(out.header));
  out.idle = await measureTyping(30, 25);
  log('B reposo:', JSON.stringify(out.idle));

  // ---------- B/C. chat nuevo con respuesta larga ----------
  await clickInPage('#btn-new');
  await page.waitForTimeout(2500);
  await page.fill('#input', LONG_PROMPT);
  await page.click('#btn-send');
  await page.waitForFunction(() => window.__aegisWeb.state.busy, null, { timeout: 30000 });
  // Empezamos a medir apenas hay texto en pantalla (el stream puede durar pocos segundos).
  await page.waitForFunction(() => document.querySelector('.msg-a.streaming'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(900);
  out.streaming.busy = (await snapshot()).busy;
  out.streaming.headerDuringRun = await measureHeader();
  out.streaming.duringRun = await snapshot();
  out.streaming.typingThrottled = await measureTyping(30, 20);
  out.streaming.charsAfterA = await page.evaluate(() => (document.querySelector('.msg-a .content')?.textContent || '').length);
  out.streaming.stillStreamingForAB = (await snapshot()).busy;
  await forceUnthrottled(600);
  out.streaming.typingUnthrottled = await measureTyping(30, 20);
  out.streaming.charsAfterB = await page.evaluate(() => (document.querySelector('.msg-a .content')?.textContent || '').length);
  out.streaming.typingThrottledAgain = await measureTyping(30, 20);
  out.streaming.charsAfterC = await page.evaluate(() => (document.querySelector('.msg-a .content')?.textContent || '').length);
  await page.screenshot({ path: shots + '/audit-phone-streaming.png' });
  log('B streaming (throttled):', JSON.stringify(out.streaming.typingThrottled));
  log('B streaming (sin throttle = antes):', JSON.stringify(out.streaming.typingUnthrottled));
  log('B streaming (2ª medición con throttle):', JSON.stringify(out.streaming.typingThrottledAgain));
  log('C durante el run:', JSON.stringify(out.streaming.duringRun));

  // ---------- C. Detener (con el turno realmente en curso) ----------
  const preStop = await snapshot();
  out.stop.beforeStop = preStop;
  if (preStop.stopVisible) {
    const t0 = Date.now();
    await page.click('#btn-stop');
    out.stop.cancellingSeen = await page
      .waitForFunction(() => {
        const b = document.querySelector('#runbar');
        return b && !b.hidden && (b.classList.contains('cancelling') || b.classList.contains('done'));
      }, null, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    out.stop.stoppedInMs = await page.waitForFunction(() => !window.__aegisWeb.state.busy, null, { timeout: 30000 }).then(() => Date.now() - t0).catch(() => 'timeout-30s');
  } else {
    out.stop.note = 'no había run activo al llegar al bloque de Detener';
  }
  await page.waitForTimeout(500);
  out.stop.after = await snapshot();
  out.stop.inputStillWorks = await page.evaluate(async () => {
    const t = document.querySelector('#input');
    t.value = 'hola';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(r));
    return t.value === 'hola' && t.offsetHeight > 0;
  });
  log('C tras Detener:', JSON.stringify(out.stop));

  // ---------- C. se cae el WebSocket en medio del turno ----------
  await page.fill('#input', LONG_PROMPT);
  await page.click('#btn-send');
  await page.waitForFunction(() => window.__aegisWeb.state.busy && document.querySelector('.msg-a.streaming'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  out.offline.beforeDrop = await snapshot();
  await page.evaluate(() => window.__aegisWeb.dropSocket());
  out.offline.recovered = await page
    .waitForFunction(() => !window.__aegisWeb.state.busy, null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  out.offline.afterDrop = await snapshot();
  await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1200);
  out.offline.afterReconnect = await snapshot();
  out.offline.canSendAfter = await page.evaluate(async () => {
    const t = document.querySelector('#input');
    t.value = 'prueba de escritura';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(r));
    return t.value === 'prueba de escritura' && !window.__aegisWeb.state.busy;
  });
  log('C tras cortar el WS:', JSON.stringify(out.offline));
  await page.screenshot({ path: shots + '/audit-phone-after-drop.png' });
} catch (e) {
  out.fatal = String(e && e.stack ? e.stack : e).slice(0, 600);
} finally {
  console.log('RESULT ' + JSON.stringify(out, null, 2));
  await browser.close();
}
