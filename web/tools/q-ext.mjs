import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
fs.copyFileSync('C:/Aegis-Proyects/state/data/sessions/sessions.db', 'C:/Aegis-Proyects/tmp/g3.db');
const db = new DatabaseSync('C:/Aegis-Proyects/tmp/g3.db', { readOnly: true });
console.log('--- extension_data crudo de sesiones con goal ---');
for (const r of db.prepare("select id, updated_at, cast(extension_data as text) as e from sessions where cast(extension_data as text) like '%goal%' order by updated_at desc limit 2").all())
  console.log('  ' + r.id + ' :: ' + r.e.slice(0, 700));
console.log('--- cuantas sesiones tienen goal activo ---');
console.log('  con goal/grind no nulo: ' + db.prepare("select count(*) n from sessions where cast(extension_data as text) like '%\"goal\":\"%' or cast(extension_data as text) like '%\"grind\":\"%'").get().n);
console.log('  total sesiones: ' + db.prepare('select count(*) n from sessions').get().n);
db.close();
