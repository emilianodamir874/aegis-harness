import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 25000 });
await p.waitForTimeout(2500);
await p.click('[data-id="20261016_9"]');
await p.waitForTimeout(12000);
const info = await p.evaluate(() => {
  const st = window.__aegisWeb.state;
  const msgs = document.getElementById('messages');
  const cadena = (el) => { const c = []; let a = el; while (a && c.length < 9) { c.push(a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + (a.className ? '.' + String(a.className).split(' ').slice(0, 3).join('.') : '')); a = a.parentElement; } return c; };
  const tablas = [...document.querySelectorAll('#messages table')];
  const celdasPaso = [...document.querySelectorAll('#messages td, #messages th')].filter((e) => /^(paso|valor)$/.test((e.textContent || '').trim()));
  const rec = [...document.querySelectorAll('#messages *')].filter((e) => e.children.length === 0 && /omitidos del replay/.test(e.textContent || ''));
  return {
    sesion: st.current ? st.current.id : null,
    hijos: msgs ? msgs.children.length : -1,
    tablas: tablas.length,
    primeraTabla: tablas.length ? { clase: String(tablas[0].className), html: tablas[0].outerHTML.slice(0, 400), celdas: tablas[0].querySelectorAll('td').length } : null,
    celdasPasoValor: celdasPaso.length,
    cadenaCelda: celdasPaso.length ? cadena(celdasPaso[0]) : null,
    recortes: rec.length,
    cadenaRecorte: rec.length ? cadena(rec[0]) : null,
    estiloRecorte: rec.length ? (() => { const cs = getComputedStyle(rec[0]); return { clase: String(rec[0].className), color: cs.color, fontSize: cs.fontSize, display: cs.display }; })() : null,
  };
});
await p.screenshot({ path: 'C:/Users/Emiliano/tmp/inv/tarjetas.png', fullPage: false });
console.log(JSON.stringify(info, null, 1));
await b.close();
