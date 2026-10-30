// Chequeo corto: despues de reescribir app.css, las reglas nuevas siguen aplicando
// (un BOM al inicio de la hoja no debe romper el parseo) y la cola queda exenta de
// content-visibility. No usa sesiones ni prompts: inyecta un nodo y lee estilos.
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3788/';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(url, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 30000 });
const r = await p.evaluate(() => {
  // en la bienvenida todavia no hay chat abierto: se usa un contenedor temporal con el
  // mismo id (el selector a comprobar es justamente #msg-inner > :nth-last-child)
  const temporal = !document.querySelector('#msg-inner');
  const inner = document.querySelector('#msg-inner') || Object.assign(document.createElement('div'), { id: 'msg-inner', style: 'width:600px' });
  if (temporal) document.body.appendChild(inner);
  const previo = document.createElement('div');
  previo.className = 'msg-a';
  previo.textContent = 'mensaje viejo del historial';
  inner.appendChild(previo);
  const d = document.createElement('div');
  d.className = 'msg-a';
  const t = document.createElement('div');
  t.className = 'thought';
  t.textContent = 'texto de razonamiento de prueba que ocupa varias lineas para poder medir el corte';
  d.appendChild(t);
  inner.appendChild(d);
  const cp = getComputedStyle(t);
  const out = {
    maxHeight: cp.maxHeight,
    lineHeight: cp.lineHeight,
    cortaEnLineaEntera: (() => {
      const l = parseFloat(cp.lineHeight), a = t.clientHeight;
      return Math.min(a % l, l - (a % l)) < 1.5;
    })(),
    cvUltimo: getComputedStyle(d).contentVisibility,
    cvPrimero: inner.firstElementChild ? getComputedStyle(inner.firstElementChild).contentVisibility : null,
  };
  d.remove();
  previo.remove();
  if (temporal) inner.remove();
  return out;
});
console.log(JSON.stringify({ ...r, erroresPagina: errs }, null, 1));
console.log(r.maxHeight !== 'none' && r.cortaEnLineaEntera && r.cvUltimo === 'visible' ? 'ok: hoja parseada y reglas activas' : 'FALLA: revisar parseo de app.css');
await b.close();
process.exit(0);
