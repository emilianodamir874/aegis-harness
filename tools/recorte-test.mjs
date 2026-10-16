import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 25000 });
await p.waitForTimeout(2500);
// 1) prueba determinista: se inyecta un mensaje con el texto exacto que agrega el servidor
const inyectado = await p.evaluate(async () => {
  const caja = document.getElementById('messages');
  const cont = document.createElement('div');
  cont.className = 'msg-a';
  const inner = document.createElement('div');
  inner.className = 'content';
  const par = document.createElement('p');
  par.textContent = 'Cierre del análisis.\n… [recortado: 18182 bytes omitidos del replay]';
  inner.appendChild(par); cont.appendChild(inner); caja.appendChild(cont);
  await new Promise((r) => setTimeout(r, 600));
  const marca = cont.querySelector('.replay-cut');
  const cs = marca ? getComputedStyle(marca) : null;
  return { aparecio: !!marca, texto: marca ? marca.textContent : null, esNota: cs ? { display: cs.display, fontSize: cs.fontSize, estilo: cs.fontStyle, color: cs.color, bordeIzq: cs.borderLeftWidth } : null, parrafoSigueCompleto: par.textContent.includes('Cierre del análisis') };
});
// 2) en la sesion real: buscar el aviso y, si no esta, cargar mas historia
await p.click('#btn-menu').catch(() => {});
await p.waitForTimeout(700);
await p.click('[data-id="20261016_9"]');
await p.waitForTimeout(11000);
let real = await p.evaluate(() => ({ marcas: document.querySelectorAll('.replay-cut').length, hayBotonCargar: !!document.querySelector('#tail-pill, .tail-pill, [id*="tail"]') }));
if (!real.marcas) {
  // intentar traer la historia completa
  const cargado = await p.evaluate(async () => {
    const pill = document.querySelector('#tail-pill, .tail-pill, [id*="tail"]');
    if (pill) { pill.click(); return 'click en la pildora de cola'; }
    return 'sin control de cola visible';
  });
  await p.waitForTimeout(9000);
  real = await p.evaluate((c) => ({ marcas: document.querySelectorAll('.replay-cut').length, accion: c, mensajes: document.querySelectorAll('#messages .msg-a, #messages .msg-u').length }), cargado);
}
await p.screenshot({ path: 'C:/Users/Emiliano/tmp/inv/recorte-cel.png' });
console.log(JSON.stringify({ inyectado, real }, null, 1));
await b.close();
