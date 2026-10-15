// Verificacion de la lectura en voz alta (sin audio). Stream monotono, como en la realidad.
import { chromium } from 'playwright';
const br = await chromium.launch();
const ctx = await br.newContext({ viewport: { width: 430, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.read, null, { timeout: 20000 });
await p.evaluate(() => {
  window.__spoke = []; window.__cancel = 0;
  const fake = { speak: (u) => window.__spoke.push(String(u.text)), cancel: () => { window.__cancel++; }, getVoices: () => [{ lang: 'es-AR', name: 't' }], addEventListener: () => {} };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, writable: true, value: fake });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: function (t) { this.text = t; } });
});
const hablado = () => p.evaluate(() => window.__spoke);
console.log('1) modo apagado');
await p.evaluate((t) => window.__aegisWeb.read.pump('k1', t), '## Para escuchar\nNo debe sonar.');
console.log('   -> ' + JSON.stringify(await hablado()));
console.log('2) modo encendido, stream creciendo (incluye markdown a medias)');
await p.evaluate(() => window.__aegisWeb.read.toggle(true));
const partes = [
  '## Para escuchar\nPrimera fra',
  '## Para escuchar\nPrimera frase corta.',
  '## Para escuchar\nPrimera frase corta. Segunda fra',
  '## Para escuchar\nPrimera frase corta. Segunda frase con **negri',
  '## Para escuchar\nPrimera frase corta. Segunda frase con **negrita** y `codigo`. Cormoran',
  '## Para escuchar\nPrimera frase corta. Segunda frase con **negrita** y `codigo`. Cormoran\n\n## Detalle tecnico\nEsto no se lee.',
];
for (let i = 0; i < partes.length; i++) {
  await p.evaluate(([k, t]) => window.__aegisWeb.read.pump(k, t), ['k2', partes[i]]);
  console.log('   parte ' + (i + 1) + ' -> ' + JSON.stringify(await hablado()));
}
console.log('3) el resto de la respuesta no se lee, y el cierre de turno completa lo que falte');
await p.evaluate(() => window.__aegisWeb.read.pump('k3', '## Para escuchar\nSin punto final al cierre'));
console.log('   antes del flush -> ' + JSON.stringify(await hablado()));
await p.evaluate(() => window.__aegisWeb.read.flush());
console.log('   tras flush       -> ' + JSON.stringify(await hablado()));
console.log('4) mensaje sin bloque');
await p.evaluate(() => window.__aegisWeb.read.pump('k4', '## Solo tecnico\nNada para leer aca.'));
console.log('   -> ' + JSON.stringify(await hablado()));
console.log('5) apagar');
await p.evaluate(() => window.__aegisWeb.read.toggle(false));
await p.evaluate((t) => window.__aegisWeb.read.pump('k5', t), '## Para escuchar\nNo debe sonar.');
console.log('   -> ' + JSON.stringify(await hablado()) + ' | cancelaciones: ' + (await p.evaluate(() => window.__cancel)));
console.log('errores: ' + JSON.stringify(errs));
await br.close();
