// Mide el /tts real (con la sesión del navegador): pide una frase, decodifica el WAV en la página
// y devuelve pico y RMS en dBFS + duración. Sirve para confirmar el headroom.
import { chromium } from 'playwright';

const url = process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788';
const FRASE = 'Buenas tardes. Esta es la medición del headroom después del reinicio del servidor web.';
const VOZ = process.env.VOZ || 'es_AR-daniela-high';
const NS = process.env.NS || '';
const NW = process.env.NW || '';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  const q = '/tts?voice=' + encodeURIComponent(VOZ) + '&text=' + encodeURIComponent(FRASE)
    + (NS ? '&ns=' + NS : '') + (NW ? '&nw=' + NW : '');
  const r = await page.evaluate(async (path) => {
    const res = await fetch(path);
    if (!res.ok) return { status: res.status, error: await res.text() };
    const buf = await res.arrayBuffer();
    const dv = new DataView(buf);
    const ascii = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
    let off = 12, sr = 0, ch = 0, bits = 0;
    while (off + 8 <= buf.byteLength) {
      const id = ascii(off, 4);
      const tam = dv.getUint32(off + 4, true);
      if (id === 'fmt ') { ch = dv.getUint16(off + 10, true); sr = dv.getUint32(off + 12, true); bits = dv.getUint16(off + 22, true); }
      if (id === 'data') {
        const ini = off + 8, fin = Math.min(ini + tam, buf.byteLength);
        let pico = 0, suma = 0, n = 0;
        for (let i = ini; i + 1 < fin; i += 2) {
          const v = dv.getInt16(i, true);
          const a = Math.abs(v);
          if (a > pico) pico = a;
          suma += (v / 32768) * (v / 32768);
          n++;
        }
        const rms = Math.sqrt(suma / Math.max(1, n));
        const db = (x) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -999);
        return { status: res.status, bytes: buf.byteLength, sr, ch, bits, dur: Math.round((n / (sr || 1)) * 100) / 100, picoDb: db(pico / 32768), rmsDb: db(rms) };
      }
      off += 8 + tam + (tam % 2);
    }
    return { status: res.status, bytes: buf.byteLength, error: 'sin chunk data' };
  }, q);
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
