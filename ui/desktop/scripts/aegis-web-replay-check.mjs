// Mide el costo del replay INICIAL de la sesión más grande (contenido, no inactividad):
// long tasks, peor hueco entre frames, tiempo total de carga y latencia de tecleo inmediata.
// Uso: node scripts/aegis-web-replay-check.mjs [salida.json]
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const br = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ctx.addInitScript(() => {
  window.__rt = { longs: [], gaps: [], t0: 0, painted: [], frames: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__rt.longs.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ entryTypes: ['longtask'] });
  } catch {}
  let last = 0;
  const tick = (t) => { if (last) window.__rt.gaps.push(Math.round(t - last)); else last = t; window.__rt.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  document.addEventListener('DOMContentLoaded', () => { window.__rt.t0 = Math.round(performance.now()); });
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
await page.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__aegisWeb?.state.sessions || []).length > 0, null, { timeout: 60000 });
const big = await page.evaluate(() => {
  const s = [...window.__aegisWeb.state.sessions].sort((a, b) => ((b._meta?.messageCount) || 0) - ((a._meta?.messageCount) || 0))[0];
  const sid = s && (s.sessionId || s.id);
  localStorage.setItem('gweb.last', sid);
  return { id: sid, msgs: s?._meta?.messageCount || 0 };
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__aegisWeb?.state?.booted && window.__aegisWeb?.state?.current, null, { timeout: 120000 });
const t0 = Date.now();
// El replay arranca cuando llega el historial: esperar a que pinten mensajes y el replay cierre.
await page.waitForFunction(() => {
  const g = window.__aegisWeb;
  return g?.state?.current && document.querySelectorAll('.msg-a,.msg-user,.tool').length > 100 && g.state.replaying === false;
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1200); // deja drenar el último tramo del render
const cargaMs = Date.now() - t0;
const st = await page.evaluate(() => {
  const g = window.__aegisWeb, rt = window.__rt;
  return {
    pintados: document.querySelectorAll('.msg-a,.msg-user,.tool').length,
    nodos: document.querySelectorAll('#msg-inner *').length,
    frames: rt.frames,
    peorHueco: rt.gaps.length ? Math.max(...rt.gaps) : 0,
    huecosSobre50: rt.gaps.filter((x) => x > 50).length,
    longs: rt.longs.filter((l) => l.d > 50).map((l) => l).slice(-12),
    longsTotalMs: Math.round(rt.longs.filter((l) => l.d > 50).reduce((a, b) => a + b.d, 0)),
    longsMax: rt.longs.length ? Math.max(...rt.longs.map((l) => l.d)) : 0, metrics: { renders: g.metrics.renders, renderMs: Math.round(g.metrics.renderMs), maxRenderMs: Math.round(g.metrics.maxRenderMs) },
    t0: rt.t0,
  };
});
// tecleo inmediatamente después de que termina la carga (el tramo que el operador siente lento)
const tipo = await page.evaluate(async () => {
  const ta = document.querySelector('#input');
  let p = null;
  try { performance.mark('k0'); } catch {}
  const lat = [];
  for (let i = 0; i < 30; i++) {
    const t = performance.now();
    ta.focus();
    ta.value += 'x';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    lat.push(performance.now() - t);
    if (i === 14) p = { m: 1 };
  }
  lat.sort((a, b) => a - b);
  ta.value = '';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return { p50: +lat[15].toFixed(1), p95: +lat[Math.floor(lat.length * 0.95)].toFixed(1), max: +lat[lat.length - 1].toFixed(1) };
});
const out = { version: await page.evaluate(() => 'v' + (window.__aegisWeb ? '' : '')), sesion: big, cargaMs, ...st, tecleoPostCarga: tipo, errores: errs };
const dest = process.argv[2] || 'C:/aegis-web/tools/replay-check.json';
writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await br.close();
process.exit(0);

