// Prueba de dictado con VOZ REAL (WAV de TTS en espanol). Reemplaza a dictation-try.mjs,
// que usaba un tono sintetico (sirve para validar parametros, no calidad).
// Uso: node tools/voz-test.mjs ["C:\\Aegis-Proyects\\core\\tmp\\voz-es.wav"] [provider]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const wavPath = process.argv[2] || 'C:\\Aegis-Proyects\\core\\tmp\\voz-es.wav';
const soloProv = process.argv[3] || '';
const ESPERADO = 'Hola, esto es una prueba de dictado por voz para Aegis. Quiero saber si transcribe bien el espanol.';
const b64 = readFileSync(wavPath).toString('base64');
console.log('wav=' + wavPath + ' (' + b64.length + ' chars b64)');

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const dist = (a, b) => { // Levenshtein por palabras -> % de acierto
  const A = norm(a).split(' ').filter(Boolean), B = norm(b).split(' ').filter(Boolean);
  const d = Array.from({ length: A.length + 1 }, (_, i) => Array.from({ length: B.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
  }
  const err = d[A.length][B.length];
  return Math.max(0, Math.round((1 - err / Math.max(A.length, B.length, 1)) * 100));
};

const br = await chromium.launch();
const p = await (await br.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc, null, { timeout: 20000 });
// Ojo: el objeto rpc existe antes de que el WebSocket conecte. Esperar la conexion real evita el
// "Still in CONNECTING state" que arruinaba la corrida anterior.
await p.waitForFunction(() => window.__aegisWeb.rpc.ready === true, null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(3000);

const cfg = await p.evaluate(async () => {
  try { return await window.__aegisWeb.rpc.request('_aegis/unstable/dictation/config', {}); } catch (e) { return { error: String(e.message) }; }
});
console.log('--- config ---');
console.log('  ' + JSON.stringify(cfg).slice(0, 700));

const provs = soloProv ? [soloProv] : ['groq', 'model'];
for (const prov of provs) {
  const t0 = Date.now();
  const r = await p.evaluate(async ([b, pv]) => {
    try { const v = await window.__aegisWeb.rpc.request('_aegis/unstable/dictation/transcribe', { audio: b, mimeType: 'audio/wav', provider: pv }); return { ok: true, text: String((v && v.text) || '') }; }
    catch (e) { return { ok: false, err: String(e.message).slice(0, 200) }; }
  }, [b64, prov]);
  const ms = Date.now() - t0;
  if (!r.ok) { console.log('  ' + prov + ' -> ERROR (' + ms + 'ms) ' + r.err); continue; }
  console.log('  ' + prov + ' -> OK (' + ms + 'ms), ' + r.text.length + ' chars');
  console.log('    texto: ' + JSON.stringify(r.text.slice(0, 400)));
  console.log('    acierto vs esperado: ' + dist(ESPERADO, r.text) + '%');
}
await br.close();
