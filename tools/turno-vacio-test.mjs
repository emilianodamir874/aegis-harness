import { chromium } from 'playwright';
const br = await chromium.launch();
const p = await (await br.newContext({ viewport: { width: 430, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.avisoVacio, null, { timeout: 20000 });
console.log('== turno vacio: aviso + boton de reintento ==');
const r = await p.evaluate(() => {
  window.__aegisWeb.avisoVacio('mensaje de prueba', []);
  const row = document.querySelector('.retry-row');
  const btn = row && row.querySelector('.retry-btn');
  return { hayFila: !!row, textoBoton: btn ? btn.textContent : null, visible: btn ? btn.offsetParent !== null : false, nota: [...document.querySelectorAll('.sysnote')].map((e) => e.textContent).slice(-1) };
});
console.log(JSON.stringify(r, null, 1));
console.log('errores: ' + JSON.stringify(errs));
await br.close();
