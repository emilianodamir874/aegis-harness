import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
fs.copyFileSync('C:/Aegis-Proyects/state/data/sessions/sessions.db', 'C:/Aegis-Proyects/tmp/s6.db');
const db = new DatabaseSync('C:/Aegis-Proyects/tmp/s6.db', { readOnly: true });
const q = (s, ...p) => db.prepare(s).all(...p);
console.log('--- vacios en 20261012_5 desde 13:00 UTC (v38 entro 13:14 UTC) ---');
for (const r of q("select id, timestamp from messages where session_id='20261012_5' and role='assistant' and trim(cast(content_json as text))='[]' and timestamp > '2026-10-16 13:00:00' order by id"))
  console.log('  [' + r.id + '] ' + r.timestamp);
console.log('--- ultimos 6 mensajes ---');
for (const m of q("select id, role, timestamp, substr(cast(content_json as text),1,60) as t from messages where session_id='20261012_5' order by id desc limit 6").reverse())
  console.log('  [' + m.id + '] ' + m.role + ' ' + m.timestamp + ' :: ' + m.t.replace(/\s+/g, ' '));
console.log('--- total vacios hoy en esa sesion: ' + q("select count(*) n from messages where session_id='20261012_5' and role='assistant' and trim(cast(content_json as text))='[]' and timestamp > '2026-10-16 00:00:00'")[0].n);
db.close();
