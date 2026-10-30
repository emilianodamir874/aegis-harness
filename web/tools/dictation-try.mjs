// Prueba REAL de cada proveedor de dictado contra el serve vivo, con un WAV sintetico.
// Uso: node tools/dictation-try.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b64 = readFileSync('C:\\Aegis-Proyects\\core\\tmp\\tone.b64', 'utf8').trim();
const url = process.argv[2] || 'http://127.0.0.1:3788/';
const br = await chromium.launch();
const p = await (await br.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc, null, { timeout: 20000 });
await p.waitForTimeout(2500);
const out = await p.evaluate(async (b64) => {
  const r = window.__aegisWeb.rpc;
  const res = [];
  for (const prov of ['model', 'local', 'openai', 'groq', 'elevenlabs']) {
    const t0 = Date.now();
    try {
      const v = await r.request('_aegis/unstable/dictation/transcribe', { audio: b64, mimeType: 'audio/wav', provider: prov });
      res.push(prov + ' -> OK (' + (Date.now() - t0) + 'ms) text=' + JSON.stringify(String(v && v.text).slice(0, 60)));
    } catch (e) { res.push(prov + ' -> ERROR (' + (Date.now() - t0) + 'ms) ' + String(e.message).slice(0, 130)); }
  }
  return res;
}, b64);
for (const l of out) console.log('  ' + l);
await br.close();
