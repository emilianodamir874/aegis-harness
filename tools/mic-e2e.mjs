// Prueba end-to-end del boton de dictado con microfono FALSO de Chromium: verifica el
// camino del cliente (grabar -> blob -> base64 -> transcribe -> insertar), no el proveedor.
// Uso: node tools/mic-e2e.mjs
import { chromium } from 'playwright';
const br = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const ctx = await br.newContext({ permissions: ['microphone'], viewport: { width: 430, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc, null, { timeout: 20000 });
await p.waitForFunction(() => window.__aegisWeb.rpc.ready === true, null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2500);
const has = await p.evaluate(() => !!document.getElementById('btn-mic'));
console.log('boton #btn-mic presente: ' + has);
console.log('secureContext en localhost: ' + (await p.evaluate(() => !!window.isSecureContext)));
await p.evaluate(() => {
  const rpc = window.__aegisWeb.rpc; const orig = rpc.request.bind(rpc); window.__cap = [];
  rpc.request = function (m, pr) { window.__cap.push({ m: m, keys: pr ? Object.keys(pr) : [], audio: pr && pr.audio ? pr.audio.length : 0, mime: pr && pr.mimeType, provider: pr && pr.provider }); return orig(m, pr); };
});
await p.click('#btn-mic');
await p.waitForTimeout(2500);
console.log('grabando (clase del boton): ' + JSON.stringify(await p.evaluate(() => document.getElementById('btn-mic').className)));
await p.click('#btn-mic');
await p.waitForTimeout(6000);
const out = await p.evaluate(() => ({
  cap: window.__cap,
  claseFinal: document.getElementById('btn-mic').className,
  input: document.getElementById('input').value,
  notas: Array.from(document.querySelectorAll('.sys, .sysnote, .note')).map((e) => e.textContent).slice(-3),
}));
console.log('llamadas capturadas: ' + JSON.stringify(out.cap));
console.log('clase final: ' + JSON.stringify(out.claseFinal));
console.log('input: ' + JSON.stringify(out.input.slice(0, 80)));
console.log('notas visibles: ' + JSON.stringify(out.notas));
if (errs.length) console.log('errores de pagina: ' + JSON.stringify(errs));
await br.close();