import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const sid = '20261012_5';
fs.copyFileSync('C:/Aegis-Proyects/state/data/sessions/sessions.db', 'C:/Aegis-Proyects/tmp/s22q.db');
const db = new DatabaseSync('C:/Aegis-Proyects/tmp/s22q.db', { readOnly: true });
console.log('== ultimos mensajes de ' + sid + ' ==');
for (const m of db.prepare('select id, role, timestamp, substr(cast(content_json as text),1,90) as t from messages where session_id=? order by id desc limit 8').all(sid).reverse()) {
  console.log('  [' + m.id + '] ' + m.role + ' ' + m.timestamp + ' : ' + m.t.replace(/\s+/g, ' '));
}
const v = db.prepare("select count(*) as n from messages where session_id=? and role='assistant' and trim(cast(content_json as text))='[]'").get(sid);
console.log('  vacios historicos en esa sesion: ' + v.n);
console.log('  -- vacios por hora (ultimas 6 h) --');
for (const r of db.prepare("select substr(timestamp,1,13) as h, count(*) as n from messages where session_id=? and role='assistant' and trim(cast(content_json as text))='[]' and timestamp > datetime('now','-6 hours') group by h order by h").all(sid)) console.log('     ' + r.h + ' : ' + r.n);
db.close();
console.log('== errores del serve en la ultima hora ==');
const base = 'C:/Aegis-Proyects/state/state/logs';
function walk(d, acc = []) { if (!fs.existsSync(d)) return acc; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else acc.push(p); } return acc; }
const desde = Date.now() - 3600 * 1000;
let n = 0;
for (const f of walk(base)) {
  let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const l of txt.split('\n')) {
    const m = l.match(/"timestamp":"([^"]+)"/);
    if (!m || Date.parse(m[1]) < desde) continue;
    if (!/antigravity|upstream|stream_interrupted|Connection reset|database is locked|evicted|vertical/i.test(l)) continue;
    if (!/"level":"(WARN|ERROR)"/.test(l)) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const msg = String((j.fields && (j.fields.message || j.fields.error)) || '').replace(/\s+/g, ' ').slice(0, 150);
    if (n++ < 10) console.log('  ' + m[1].slice(11, 19) + ' ' + (j.level || '?') + ' [' + ((j.span && j.span['gen_ai.provider.name']) || '') + '] ' + msg);
  }
}
console.log('  (total coincidencias: ' + n + ')');
