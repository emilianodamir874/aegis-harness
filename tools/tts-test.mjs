import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
const errs = [], tts = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
p.on('response', (r) => { if (r.url().includes('/tts')) tts.push({ motorPedido: (r.url().match(/engine=([^&]*)/) || [])[1], estado: r.status(), tipo: r.headers()['content-type'], motorServido: r.headers()['x-aegis-tts-engine'], bytes: r.headers()['content-length'] }); });
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 25000 });
await p.waitForTimeout(2500);
// simular un navegador con el motor roto guardado (como el suyo)
await p.evaluate(() => { localStorage.setItem('aegis.ttsEngine', 'edge'); localStorage.setItem('aegis.ttsVoice', 'es-AR-TomasNeural'); });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 25000 });
await p.waitForTimeout(2500);
await p.click('#btn-menu').catch(() => {});
await p.waitForTimeout(700);
await p.click('[data-id="20261016_9"]');
await p.waitForTimeout(12000);
const toggle = await p.evaluate(() => { const b = document.getElementById('btn-read'); if (!b) return { hay: false }; const r = b.getBoundingClientRect(); b.click(); return { hay: true, visible: getComputedStyle(b).display !== 'none' && r.width > 0, x: Math.round(r.x), y: Math.round(r.y), titulo: b.title || b.getAttribute('aria-label') || b.textContent.trim().slice(0, 20) }; });
await p.waitForTimeout(1200);
const estado = await p.evaluate(() => ({ encendido: localStorage.getItem('aegis.readOn') || localStorage.getItem('aegis.read'), motor: localStorage.getItem('aegis.ttsEngine') }));
// boton por mensaje visible
const cand = await p.$$('#messages .msg-read');
let clickeado = 'ninguno visible';
for (const el of cand) { const vis = await el.isVisible().catch(() => false); if (vis) { await el.click({ force: true }).catch(() => {}); clickeado = 'click en un .msg-read visible'; break; } }
await p.waitForTimeout(10000);
const notas = await p.evaluate(() => [...document.querySelectorAll('.sys-note, .note, .toast')].map((n) => n.textContent.trim()).filter((t) => /voz|audio|tts|salte/i.test(t)).slice(-3));
console.log(JSON.stringify({ toggle, estado, botones: cand.length, clickeado, pedidosTts: tts, notas, errs }, null, 1));
await b.close();
