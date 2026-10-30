// Mide el /tts real: motor usado (header), content-type, bytes y latencia (frio vs cacheado).
import { chromium } from 'playwright';

const url = process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788';
const FRASE = 'Buenas tardes. Esta es la medición del motor de voz después del reinicio.';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  const medir = (q) => page.evaluate(async (path) => {
    const t0 = performance.now();
    const res = await fetch(path);
    const buf = await res.arrayBuffer();
    return {
      ms: Math.round(performance.now() - t0),
      status: res.status,
      engine: res.headers.get('x-aegis-tts-engine'),
      tipo: res.headers.get('content-type'),
      bytes: buf.byteLength,
    };
  }, q);

  const q = '/tts?text=' + encodeURIComponent(FRASE);
  const r1 = await medir(q);
  console.log('frio:   ' + JSON.stringify(r1));
  const r2 = await medir(q);
  console.log('cache:  ' + JSON.stringify(r2));
  const q2 = '/tts?text=' + encodeURIComponent(FRASE + ' Otra frase distinta para forzar síntesis.');
  const r3 = await medir(q2);
  console.log('caliente: ' + JSON.stringify(r3));
} finally {
  await browser.close();
}
