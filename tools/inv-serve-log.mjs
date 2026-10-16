import fs from 'node:fs';
import path from 'node:path';
const base = 'C:/Aegis-Proyects/state/state/logs';
function walk(d, acc = []) {
  if (!fs.existsSync(d)) return acc;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc); else acc.push({ p, m: fs.statSync(p).mtimeMs, s: fs.statSync(p).size });
  }
  return acc;
}
const all = walk(base).sort((a, b) => b.m - a.m);
console.log('archivos de log: ' + all.length + ' | los 5 mas nuevos:');
for (const f of all.slice(0, 5)) console.log('  ' + f.p.replace(base, '') + ' | ' + (f.s / 1024).toFixed(0) + ' KB | ' + new Date(f.m).toISOString());
const sid = '20261012_5';
let porNivel = {}, mensajes = {}, ejemplos = [], lineasSesion = 0, conAntigravity = 0;
for (const f of all.slice(0, 12)) {
  let txt; try { txt = fs.readFileSync(f.p, 'utf8'); } catch { continue; }
  for (const l of txt.split('\n')) {
    if (!l.includes(sid) && !l.includes('antigravity')) continue;
    if (l.includes(sid)) lineasSesion++;
    if (l.includes('antigravity')) conAntigravity++;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const nivel = j.level || '?';
    porNivel[nivel] = (porNivel[nivel] || 0) + 1;
    const msg = (j.fields && (j.fields.message || j.fields.error)) || '';
    const clave = String(msg).replace(/[0-9a-f]{8,}/g, '<id>').replace(/\d+/g, 'N').slice(0, 110);
    if (clave) mensajes[clave] = (mensajes[clave] || 0) + 1;
    if (nivel === 'WARN' || nivel === 'ERROR') {
      const prov = (j.span && j.span['gen_ai.provider.name']) || '';
      const mod = (j.span && j.span['gen_ai.request.model']) || '';
      if (ejemplos.length < 6) ejemplos.push(nivel + ' | ' + prov + '/' + mod + ' | ' + String(msg).replace(/\s+/g, ' ').slice(0, 320));
    }
  }
}
console.log('lineas con la sesion ' + sid + ': ' + lineasSesion + ' | con antigravity: ' + conAntigravity);
console.log('por nivel: ' + JSON.stringify(porNivel));
console.log('mensajes mas repetidos:');
for (const [k, v] of Object.entries(mensajes).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log('  ' + v + 'x ' + k);
console.log('ejemplos WARN/ERROR:');
for (const e of ejemplos) console.log('  ' + e);
