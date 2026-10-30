// Gate de movimiento: la hoja usa una escala, no valores sueltos, y toda animacion respeta
// prefers-reduced-motion. Sin navegador: se lee app/app.css y se verifica el contrato.
//
// Por que existe: el problema no era "faltan animaciones" sino que habia 25 transiciones con
// duraciones ad-hoc y entradas todas iguales. Esto evita que vuelva a pasar sin que nadie lo note.
import { readFileSync } from 'node:fs';

const CSS = 'C:/Aegis-Proyects/web/app/app.css';
const css = readFileSync(CSS, 'utf8');
const filas = [];
const gate = (nombre, ok, detalle = '') => filas.push({ nombre, ok: !!ok, detalle });

// 1) la escala existe
for (const token of ['--dur-1:', '--dur-2:', '--dur-3:', '--ease-out:', '--ease-in-out:']) {
  gate('token ' + token.replace(':', ''), css.includes(token));
}

// 2) tres escalones con la relacion correcta: micro < transicion < entrada
const valor = (nombre) => {
  const m = new RegExp(nombre.replace(/-/g, '\\-') + ':\\s*(\\d+)ms').exec(css);
  return m ? Number(m[1]) : null;
};
const d1 = valor('--dur-1'), d2 = valor('--dur-2'), d3 = valor('--dur-3');
gate('duraciones crecientes', d1 && d2 && d3 && d1 < d2 && d2 < d3, `${d1}/${d2}/${d3} ms`);
gate('micro por debajo de 120 ms', d1 && d1 <= 120, String(d1));
gate('entrada por debajo de 350 ms', d3 && d3 <= 350, String(d3));

// 3) la entrada de mensaje se mueve, no solo aparece
const msgIn = /@keyframes msgIn \{([\s\S]*?)\n\}/.exec(css);
gate('msgIn declara desplazamiento', !!msgIn && /translateY\(/.test(msgIn[1]), msgIn ? 'ok' : 'sin keyframes');
const desplazamiento = msgIn && /translateY\((\d+)px\)/.exec(msgIn[1]);
gate('desplazamiento corto (<= 10px)', !!desplazamiento && Number(desplazamiento[1]) <= 10, desplazamiento ? desplazamiento[1] + 'px' : 'no declara');

// 4) los paneles entran con la curva de la escala, no con una suelta
gate('paneles con --ease-out', /\.menu[^{]*\{[^}]*animation:[^;}]*var\(--ease-out\)/.test(css));

// 5) toda animacion nueva tiene su par en reduced-motion
// Puede haber varios bloques a lo largo de la hoja: se juntan todos.
const bloquesReduce = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
  .map((m) => m[1])
  .join('\n');
gate('bloque reduced-motion presente', bloquesReduce.length > 0, String(bloquesReduce.length) + ' chars');
if (bloquesReduce) {
  for (const selector of ['.menu', '.ctx-map', '.aegis-doctor', '.aegis-changes']) {
    gate('reduced-motion cubre ' + selector, bloquesReduce.includes(selector));
  }
}

// 6) ninguna transicion con duracion literal fuera de la escala (se permiten 0 y el 400 ms del
//    medidor de contexto, que es un dato que se anima despacio a proposito)
const literales = [];
for (const m of css.matchAll(/transition:[^;{}]*?(\d+)ms/g)) {
  const ms = Number(m[1]);
  if (![0, 400].includes(ms)) literales.push(ms);
}
gate('sin duraciones sueltas en transition', literales.length === 0, literales.length ? [...new Set(literales)].join(', ') + ' ms' : 'solo tokens');

const ancho = Math.max(...filas.map((f) => f.nombre.length));
for (const f of filas) console.log((f.ok ? 'OK  ' : 'FAIL') + ' ' + f.nombre.padEnd(ancho) + '  ' + f.detalle);
const fallas = filas.filter((f) => !f.ok).length;
console.log('\n' + (filas.length - fallas) + '/' + filas.length + ' ' + (fallas ? 'con fallas' : 'PASS'));
process.exit(fallas ? 1 : 0);
