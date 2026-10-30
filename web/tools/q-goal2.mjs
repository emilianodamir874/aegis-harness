import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
fs.copyFileSync('C:/Aegis-Proyects/state/data/sessions/sessions.db', 'C:/Aegis-Proyects/tmp/g2.db');
const db = new DatabaseSync('C:/Aegis-Proyects/tmp/g2.db', { readOnly: true });
const q = (sql, ...p) => db.prepare(sql).all(...p);
console.log('COLS sessions: ' + q("select name from pragma_table_info('sessions')").map(c => c.name).join(', '));
console.log('--- mensajes de USUARIO que empiezan con /goal o /grind (ultimos 12) ---');
for (const r of q("select session_id, id, timestamp, cast(content_json as text) as t from messages where role='user' and (cast(content_json as text) like '%\"text\":\"/goal%' or cast(content_json as text) like '%\"text\":\"/grind%') order by id desc limit 12").reverse())
  console.log('  [' + r.id + '] ' + r.session_id + ' ' + r.timestamp + ' :: ' + r.t.slice(0, 120).replace(/\s+/g, ' '));
console.log('--- respuestas cortas del agente con goal (ultimas 8) ---');
for (const r of q("select session_id, id, timestamp, cast(content_json as text) as t from messages where role='assistant' and cast(content_json as text) like '%goal%' and length(cast(content_json as text)) < 500 order by id desc limit 8").reverse())
  console.log('  [' + r.id + '] ' + r.session_id + ' ' + r.timestamp + ' :: ' + r.t.slice(0, 200).replace(/\s+/g, ' '));
console.log('--- extension_data con goal ---');
for (const r of q("select session_id, substr(cast(extension_data as text),1,300) as e from sessions where cast(extension_data as text) like '%\"goal\"%' order by rowid desc limit 4"))
  console.log('  ' + r.session_id + ' :: ' + r.e.replace(/\s+/g, ' '));
db.close();
