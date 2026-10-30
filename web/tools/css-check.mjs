// Validador del CSS del cliente: llaves balanceadas, reglas que el navegador descarta
// y propiedades que quedaron fuera de bloque. Un borde mal cerrado no da error en consola:
// el navegador se come la regla siguiente en silencio (pasó con #jump-bottom).
import fs from 'node:fs';
import { chromium } from 'playwright';

const file = 'C:/Aegis-Proyects/web/app/app.css';
const raw = fs.readFileSync(file, 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

let depth = 0;
let line = 1;
const problems = [];
for (let i = 0; i < src.length; i++) {
  const c = src[i];
  if (c === '\n') line++;
  else if (c === '{') depth++;
  else if (c === '}') {
    depth--;
    if (depth < 0) problems.push(`llave de cierre sobrante en linea ${line}`);
  } else if (depth === 0 && c === ';') {
    const desde = src.lastIndexOf('\n', i);
    const frag = src.slice(desde + 1, i).trim();
    if (frag && !/^@/.test(frag)) problems.push(`declaracion fuera de bloque en linea ${line}: ${frag.slice(0, 60)}`);
  } else if (depth === 1 && c === '{') {
    problems.push(`bloque anidado en linea ${line}`);
  }
}
if (depth !== 0) problems.push(`llaves desbalanceadas: quedan ${depth} abiertas`);

// el navegador es el juez final: cuantas reglas sobreviven y cual queda rota
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent('<style id="s"></style>');
const report = await page.evaluate((text) => {
  const s = document.getElementById('s');
  s.textContent = text;
  const sheet = s.sheet;
  const rules = [...sheet.cssRules];
  const rotas = rules.filter((r) => /[{}]/.test(r.selectorText || '')).map((r) => r.cssText.slice(0, 120));
  let decls = 0;
  for (const r of rules) if (r.style) decls += r.style.length;
  return { reglas: rules.length, declaraciones: decls, rotas };
}, raw);
await browser.close();

console.log(JSON.stringify({ problemas: problems.slice(0, 20), ...report }, null, 1));
if (problems.length || report.rotas.length) process.exit(1);
