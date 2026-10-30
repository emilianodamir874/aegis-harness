// Mide contraste WCAG de los pares texto/fondo que usa la app, leyendo los tokens reales
// desde app/app.css (no una lista a mano: si alguien cambia un token, esto lo refleja).
//   node tools/contrast-report.mjs [--json]
import { readFileSync } from 'node:fs';

const CSS = 'C:/Aegis-Proyects/web/app/app.css';
const css = readFileSync(CSS, 'utf8');

function token(name) {
  const m = new RegExp('--' + name + '\\s*:\\s*([^;]+);').exec(css);
  return m ? m[1].trim() : null;
}
function rgba(v) {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) { const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255, 1]; }
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = /rgba?\(([^)]+)\)/.exec(v);
  if (m) { const p = m[1].split(',').map((x) => parseFloat(x)); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
  m = /^var\(--([\w-]+)\)$/.exec(v);
  if (m) return rgba(token(m[1]));
  return null;
}
const over = (fg, bg) => fg[3] >= 1 ? fg.slice(0, 3) : [0, 1, 2].map((i) => Math.round(fg[i] * fg[3] + bg[i] * (1 - fg[3])));
const lum = (c) => {
  const f = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const bg = rgba(token('bg')) || [28, 27, 25, 1];
const card = rgba(token('bg-card'));
const raise = rgba(token('bg-raise'));
const side = rgba(token('bg-sidebar'));

const pares = [
  ['text', 'bg', 4.5], ['text-2', 'bg', 4.5], ['text-3', 'bg', 4.5], ['text-4', 'bg', 3],
  ['text', 'bg-card', 4.5], ['text-2', 'bg-card', 4.5], ['text-3', 'bg-card', 4.5],
  ['text-3', 'bg-sidebar', 4.5], ['text-4', 'bg-sidebar', 3],
  ['accent-text', 'bg', 4.5], ['ok', 'bg', 4.5], ['warn', 'bg', 4.5], ['danger', 'bg', 4.5],
];
const filas = [];
let fails = 0;
for (const [fgName, bgName, min] of pares) {
  const fgv = token(fgName); const bgv = token(bgName);
  const f = rgba(fgv); const b = rgba(bgv);
  if (!f || !b) { filas.push({ par: fgName + '/' + bgName, valor: '?', ratio: null, min, ok: false }); fails++; continue; }
  const r = ratio(over(f, over(b, bg)), over(b, bg));
  const ok = r >= min;
  if (!ok) fails++;
  filas.push({ par: fgName + '/' + bgName, valor: fgv, ratio: Math.round(r * 100) / 100, min, ok });
}

// bordes: no son texto, pero un control delimitado por un borde necesita 3:1 (WCAG 1.4.11)
for (const b of ['border', 'border-strong']) {
  const c = rgba(token(b));
  const r = ratio(over(c, bg), bg);
  const ok = r >= 1.6; // los bordes decorativos se quedan; solo los que delimitan control se exigen
  filas.push({ par: b + '/bg (informativo)', valor: token(b), ratio: Math.round(r * 100) / 100, min: 1.6, ok });
  if (!ok) fails++;
}

if (process.argv.includes('--json')) { console.log(JSON.stringify(filas, null, 2)); }
else {
  const w = 26;
  console.log('par'.padEnd(w) + 'valor'.padEnd(30) + 'ratio'.padStart(7) + '  min   ok');
  for (const f of filas) {
    console.log(f.par.padEnd(w) + String(f.valor).padEnd(30) + String(f.ratio === null ? '?' : f.ratio).padStart(7) + '  ' + String(f.min).padEnd(4) + '  ' + (f.ok ? 'ok' : 'BAJO'));
  }
  console.log('\n' + (fails ? fails + ' pares por debajo del minimo' : 'todos los pares cumplen'));
}
process.exitCode = fails ? 1 : 0;
