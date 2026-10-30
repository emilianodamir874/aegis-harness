// Verifica el arreglo del duplicado visual al recargar rapido. Mide el EFECTO, no la intencion:
//   1) un contenedor .msg-inner como maximo;
//   2) el TEXTO total y la cantidad de globos de una carga normal deben coincidir con los de una
//      carga doble solapada (si el arreglo no estuviera, cada chunk se aplicaria dos veces y el
//      texto saldria ~2x);
//   3) ningun globo cuyo texto sea la repeticion exacta de su mitad (duplicado dentro del globo).
// Usa la sesion MAS VIEJA de la lista para que no la haga crecer un turno en curso.
// Uso: node tools/dup-messages-check.mjs [url]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3788/';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

const stats = () => p.evaluate(() => {
  const box = document.querySelector('#messages');
  const bubbles = [...document.querySelectorAll('#messages .msg-a .content')].map((e) => e.textContent);
  let dup = 0;
  for (const x of bubbles) {
    const s = x.trim();
    if (s.length >= 60 && s.length % 2 === 0) {
      const h = s.slice(0, s.length / 2);
      if (h === s.slice(s.length / 2)) dup++;
    }
  }
  return {
    contenedores: document.querySelectorAll('#messages .msg-inner').length,
    idInner: document.querySelectorAll('#msg-inner').length,
    globos: box ? box.querySelectorAll('.msg-a, .msg-user, .tool').length : 0,
    texto: box ? box.textContent.trim().length : 0,
    globosDuplicados: dup,
    conn: (document.querySelector('#conn-text') || {}).textContent || '',
  };
});

await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.evaluate(() => { try { window.__aegisWeb.refreshSessions(); } catch (e) {} });
await p.waitForSelector('.sb-item', { timeout: 15000 });
await p.waitForTimeout(1200);

const items = await p.$$('.sb-item');
const last = items[items.length - 1];          // la mas vieja: no la hace crecer un turno en curso

await last.click(); await p.waitForTimeout(5000);
const base = await stats();
console.log('carga normal        ' + JSON.stringify(base));

await last.click(); await p.waitForTimeout(5000);
const base2 = await stats();
console.log('carga normal (2)    ' + JSON.stringify(base2));

await last.click(); await p.waitForTimeout(90);   // solapa a proposito
await last.click();
await p.waitForTimeout(7000);
const raced = await stats();
console.log('carga doble solapada ' + JSON.stringify(raced));

const tol = Math.max(40, Math.round(base2.texto * 0.02));
const textoOk = Math.abs(raced.texto - base2.texto) <= tol;
const globosOk = Math.abs(raced.globos - base2.globos) <= 2;
const contOk = raced.contenedores <= 1 && raced.idInner <= 1;
const dupOk = raced.globosDuplicados === 0 && base2.globosDuplicados === 0;
console.log('contenedor unico : ' + (contOk ? 'OK' : 'FALLA'));
console.log('texto sin duplicar: ' + (textoOk ? 'OK' : 'FALLA') + ' (normal ' + base2.texto + ' vs solapada ' + raced.texto + ')');
console.log('globos sin duplicar: ' + (globosOk ? 'OK' : 'FALLA') + ' (normal ' + base2.globos + ' vs solapada ' + raced.globos + ')');
console.log('globos repetidos  : ' + (dupOk ? 'OK' : 'FALLA') + ' (encontrados ' + raced.globosDuplicados + ')');
console.log('errores de consola: ' + errs.length + (errs.length ? ' :: ' + errs.slice(0, 3).join(' | ') : ''));
console.log(contOk && textoOk && globosOk && dupOk ? 'RESULTADO: OK' : 'RESULTADO: HAY FALLAS');
await b.close();
