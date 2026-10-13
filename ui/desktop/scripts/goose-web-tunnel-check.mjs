// Check del tunel Cloudflare de goose-web (v7): puerta de login, WS sin sesion, y round-trip
// real por el tunel (login -> app -> wss://<host>/acp -> session/list -> replay de una sesion).
// Uso: node scripts/goose-web-tunnel-check.mjs [https://xxx.trycloudflare.com]
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const arg = process.argv[2];
const urlTxt = await readFile('C:/goose-web/tunnel-url.txt', 'utf8').catch(() => '');
const base = (arg || (urlTxt.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/) || [])[0] || '').replace(/\/$/, '');
if (!base) {
  console.log(JSON.stringify({ ok: false, motivo: 'sin URL: tunnel-url.txt vacio' }));
  process.exit(1);
}
const pw = JSON.parse(await readFile('C:/goose-web/auth.json', 'utf8')).password;
const out = { url: base };

// 1) la puerta: sin cookie no se ve nada
out.healthz = await (await fetch(base + '/healthz')).json();
const rootNoAuth = await fetch(base + '/', { redirect: 'manual', headers: { accept: 'text/html' } });
const cfgNoAuth = await fetch(base + '/config.js', { redirect: 'manual' });
out.puerta = {
  root: rootNoAuth.status,
  rootTo: rootNoAuth.headers.get('location'),
  configjs: cfgNoAuth.status,
  api: (await fetch(base + '/client-log', { method: 'POST', body: 'x' })).status,
};

// 2) WS sin sesion: el upgrade tiene que rebotar
out.wsSinSesion = await new Promise((res) => {
  const w = new WebSocket(base.replace('https', 'wss') + '/acp?token=x');
  const t = setTimeout(() => res('timeout (MAL)'), 15000);
  const done = (v) => { clearTimeout(t); res(v); };
  w.onerror = () => done('error/rechazado');
  w.onopen = () => { try { w.close(); } catch {} done('ABIERTO (MAL)'); };
  w.onclose = (e) => done('cerrado ' + e.code);
});

// 3) browser real: login -> app -> conectado por el tunel
const br = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
out.login = { url: page.url(), form: await page.locator('input[name=password]').count() };
await page.fill('input[name=password]', pw);
await Promise.all([
  page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30000 }).catch(() => {}),
  page.click('button[type=submit]'),
]);
await page.waitForSelector('#input', { timeout: 30000 }).catch(() => {});
await page
  .waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 60000 })
  .catch(() => {});
await page.waitForTimeout(2000);
out.app = await page.evaluate(() => ({
  acpUrl: (window.__GOOSE_APP__ || {}).acpUrl,
  tunnel: (window.__GOOSE_APP__ || {}).tunnel,
  conectado: document.querySelector('#conn-text')?.textContent,
  host: document.querySelector('#conn-host')?.textContent,
  sesiones: (((window.__gooseWeb || {}).state || {}).sessions || []).length,
  rpcReady: Boolean(((window.__gooseWeb || {}).rpc || {}).ready),
}));

console.log('PASO app ' + JSON.stringify(out.app)); // el sidebar movil es un drawer: ensancho para clickear

// 4) replay de la sesion mas reciente (datos reales de ida y vuelta por el tunel)
await page.setViewportSize({ width: 1100, height: 800 });
await page.waitForTimeout(600);
const first = await page.locator('#session-list .sb-row').first().getAttribute('data-id').catch(() => null);
if (first) {
  await page.click(`#session-list .sb-row[data-id="${first}"]`);
  await page.waitForTimeout(5000);
  out.replay = await page.evaluate(() => ({
    sid: (((window.__gooseWeb || {}).state || {}).current || {}).id,
    mensajes: document.querySelectorAll('.msg-a, .msg-u').length,
  }));
} else {
  out.replay = 'sin sesiones en el sidebar';
}
out.cookies = (await ctx.cookies(base)).map((c) => c.name);
out.errores = errs;
await br.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
