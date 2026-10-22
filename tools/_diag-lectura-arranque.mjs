// Mide cuanto tarda en salir el PRIMER /tts cuando el texto llega en streaming.
import { chromium } from 'playwright';

const url = process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788';
const TEXTO = 'Primero una frase larga que tarda en completarse y que antes retrasaba el arranque de la voz, '
  + 'despues otra frase, y al final un cierre corto para completar el bloque de lectura.';

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  const pedidos = [];
  page.on('request', (r) => {
    if (r.url().includes('/tts?')) pedidos.push({ t: Date.now(), url: r.url() });
  });
  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);
  await page.click('#btn-read');
  await page.waitForTimeout(300);

  const t0 = Date.now();
  const texto = '## Para escuchar\n\n' + TEXTO;
  for (let i = 10; i <= texto.length; i += 20) {
    await page.evaluate((t) => window.__aegisWeb.read.pump('stream-1', t), texto.slice(0, i));
    await page.waitForTimeout(40);
    if (pedidos.length) break;
  }
  const primero = pedidos[0];
  if (!primero) throw new Error('no salio ningun pedido a /tts');
  const chars = decodeURIComponent(primero.url.split('&text=')[1] || '').length;
  console.log('primer pedido a los ' + (primero.t - t0) + ' ms, con ' + chars + ' chars de texto');
  console.log('texto: ' + decodeURIComponent(primero.url.split('&text=')[1] || '').slice(0, 100));
} finally {
  await browser.close();
}
