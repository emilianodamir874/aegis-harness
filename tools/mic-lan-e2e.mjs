// Prueba del dictado por voz sobre la URL https de LAN (la que habilita getUserMedia).
// Verifica: contexto seguro + boton #btn-mic + grabacion + request de transcripcion con audio.
// Uso: node tools/mic-lan-e2e.mjs https://192.168.100.34:3789/
import { chromium } from 'playwright';

const target = process.argv[2] || 'https://192.168.100.34:3789/';
const br = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'],
});
const ctx = await br.newContext({ permissions: ['microphone'], ignoreHTTPSErrors: true, viewport: { width: 430, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
await p.goto(target, { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc, null, { timeout: 20000 });
await p.waitForFunction(() => window.__aegisWeb.rpc.ready === true, null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2500);
console.log('URL: ' + target);
console.log('secureContext: ' + (await p.evaluate(() => !!window.isSecureContext)));
console.log('mediaDevices: ' + (await p.evaluate(() => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia))));
console.log('cfg acpUrl: ' + (await p.evaluate(() => (window.__AEGIS_CONFIG || {}).acpUrl || '(sin cfg)')));
console.log('ws listo: ' + (await p.evaluate(() => window.__aegisWeb.rpc.ready === true)));
console.log('boton #btn-mic: ' + (await p.evaluate(() => !!document.getElementById('btn-mic'))));

await p.evaluate(() => {
  const rpc = window.__aegisWeb.rpc; const orig = rpc.request.bind(rpc); window.__cap = [];
  rpc.request = function (m, pr) { window.__cap.push({ m: m, keys: pr ? Object.keys(pr) : [], audio: pr && pr.audio ? pr.audio.length : 0, mime: pr && pr.mimeType, provider: pr && pr.provider }); return orig(m, pr); };
});
await p.click('#btn-mic');
await p.waitForTimeout(2500);
console.log('grabando: ' + JSON.stringify(await p.evaluate(() => document.getElementById('btn-mic').className)));
await p.click('#btn-mic');
await p.waitForTimeout(7000);
const cap = await p.evaluate(() => window.__cap || []);
console.log('requests capturados: ' + JSON.stringify(cap));
const notes = await p.evaluate(() => Array.from(document.querySelectorAll('.sys-note, .system-note')).slice(-3).map((n) => n.textContent.trim().slice(0, 120)));
console.log('notas en pantalla: ' + JSON.stringify(notes));
console.log('errores de pagina: ' + JSON.stringify(errs));
await br.close();
