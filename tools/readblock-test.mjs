import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 25000 });
await p.waitForTimeout(2500);
await p.click('#btn-menu').catch(() => {});
await p.waitForTimeout(700);
await p.click('[data-id="20261016_9"]');
await p.waitForTimeout(12000);
const diag = await p.evaluate(() => {
  const res = { mensajes: 0, conEncabezado: 0, readBlockOk: 0, botonesVisibles: 0, botonesOcultos: 0, ejemplos: [] };
  const cuerpos = [...document.querySelectorAll('#messages .msg-a .content')];
  res.mensajes = cuerpos.length;
  for (const c of cuerpos) {
    const texto = c.innerText || '';
    const tiene = /para escuchar/i.test(texto);
    if (tiene) res.conEncabezado++;
    // el boton de ese mensaje
    const el = c.closest('.msg-a');
    const btn = el ? el.querySelector('.msg-read') : null;
    if (btn) { if (btn.hidden) res.botonesOcultos++; else res.botonesVisibles++; }
    if (res.ejemplos.length < 3 && tiene) {
      const rb = window.__aegisWeb.readBlock ? window.__aegisWeb.readBlock(texto) : null;
      const rh = window.__aegisWeb.readHeading ? window.__aegisWeb.readHeading(texto) : null;
      res.ejemplos.push({ tieneEncabezado: true, readHeading: !!rh, readBlockLargo: rb ? rb.length : 0, boton: btn ? (btn.hidden ? 'oculto' : 'visible') : 'no existe', arranque: texto.slice(0, 42).replace(/\n/g, ' ') });
    }
  }
  return res;
});
console.log(JSON.stringify(diag, null, 1));
await b.close();
