import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
fs.copyFileSync('C:/Aegis-Proyects/state/data/sessions/sessions.db', 'C:/Aegis-Proyects/tmp/s5.db');
const db = new DatabaseSync('C:/Aegis-Proyects/tmp/s5.db', { readOnly: true });
const q = (s, ...p) => db.prepare(s).all(...p);
console.log('--- 20261012_5: ultimos 6 mensajes ---');
for (const m of q("select id, role, timestamp, substr(cast(content_json as text),1,70) as t from messages where session_id='20261012_5' order by id desc limit 6").reverse())
  console.log('  [' + m.id + '] ' + m.role + ' ' + m.timestamp + ' :: ' + m.t.replace(/\s+/g, ' '));
console.log('--- vacios en 20261012_5 por hora (hoy) ---');
for (const r of q("select substr(timestamp,1,13) as h, count(*) n from messages where session_id='20261012_5' and role='assistant' and trim(cast(content_json as text))='[]' and timestamp > '2026-10-16 00:00:00' group by h order by h"))
  console.log('  ' + r.h + ' : ' + r.n);
console.log('--- vacios en 20261012_5 DESPUES del parche v36 (10:45 UTC) ---');
const pos = q("select id, timestamp from messages where session_id='20261012_5' and role='assistant' and trim(cast(content_json as text))='[]' and timestamp > '2026-10-16 10:45:00' order by id");
console.log('  cantidad: ' + pos.length);
for (const r of pos) console.log('     [' + r.id + '] ' + r.timestamp);
console.log('--- todos los vacios del stack hoy, por sesion ---');
for (const r of q("select session_id, count(*) n, min(timestamp) p, max(timestamp) u from messages where role='assistant' and trim(cast(content_json as text))='[]' and timestamp > '2026-10-16 00:00:00' group by session_id order by u desc"))
  console.log('  ' + r.session_id + ' : ' + r.n + ' (de ' + r.p + ' a ' + r.u + ')');
db.close();
