import fs from 'node:fs';
import path from 'node:path';
const base = 'C:/Aegis-Proyects/state/state/logs';
function walk(d, acc = []) { if (!fs.existsSync(d)) return acc; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else acc.push(p); } return acc; }
const desde = Date.parse('2026-10-16T00:40:00Z');
const lineas = [];
for (const f of walk(base)) {
  let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const l of txt.split('\n')) {
    const m = l.match(/"timestamp":"([^"]+)"/);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (Number.isNaN(t) || t < desde) continue;
    lineas.push({ t, l, f: path.basename(f) });
  }
}
lineas.sort((a, b) => a.t - b.t);
console.log('lineas desde ' + new Date(desde).toISOString() + ': ' + lineas.length);
const nivel = {}, msgs = {}, provs = {}, finish = {};
for (const x of lineas) {
  let j; try { j = JSON.parse(x.l); } catch { continue; }
  const n = j.level || '?'; nivel[n] = (nivel[n] || 0) + 1;
  const msg = String((j.fields && (j.fields.message || j.fields.error)) || '').replace(/[0-9a-f]{8,}/g, '<id>').replace(/\d+/g, 'N').slice(0, 100);
  if (msg) msgs[msg] = (msgs[msg] || 0) + 1;
  const p = (j.span && j.span['gen_ai.provider.name']) || '';
  if (p) provs[p] = (provs[p] || 0) + 1;
  const f2 = (j.fields && (j.fields.finish_reasons || j.fields.finish_reason)) || (j.span && j.span['gen_ai.response.finish_reasons']);
  if (f2) { const k = JSON.stringify(f2).slice(0, 60); finish[k] = (finish[k] || 0) + 1; }
}
console.log('por nivel: ' + JSON.stringify(nivel));
console.log('por proveedor: ' + JSON.stringify(provs));
console.log('finish_reasons vistos: ' + JSON.stringify(finish));
console.log('mensajes (top 12):');
for (const [k, v] of Object.entries(msgs).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log('  ' + v + 'x ' + k);
console.log('-- lineas WARN/ERROR con antigravity o vacio/finish --');
let n = 0;
for (const x of lineas) {
  if (!/antigravity|finish_reason|empty|no content|timeout|timed out|retry|RESOURCE|429|503/i.test(x.l)) continue;
  let j; try { j = JSON.parse(x.l); } catch { continue; }
  if ((j.level || '') === 'INFO' && !/finish|empty/i.test(x.l)) continue;
  if (n++ < 10) console.log('  ' + x.t.toISOString().slice(11, 19) + ' ' + (j.level || '?') + ' | ' + String((j.fields && j.fields.message) || '').replace(/\s+/g, ' ').slice(0, 240));
}
console.log('  (total coincidentes: ' + n + ')');
