// Mira si el bloque "Para escuchar" quedo guardado en la conversacion que el serve le pasa al modelo.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const orig = 'C:/Aegis-Proyects/state/data/sessions/sessions.db';
const copia = 'C:/Aegis-Proyects/tmp/sessions-copia.db';
fs.copyFileSync(orig, copia);
console.log('copia: ' + (fs.statSync(copia).size / 1048576).toFixed(1) + ' MB');
const db = new DatabaseSync(copia, { readOnly: true });
const tablas = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
console.log('tablas: ' + tablas.join(', '));
for (const t of tablas) {
  try {
    const cols = db.prepare('select * from ' + t + ' limit 1').all();
    const nombres = cols.length ? Object.keys(cols[0]) : db.prepare("select name from pragma_table_info('" + t + "')").all().map((r) => r.name);
    console.log('  ' + t + ' -> ' + nombres.join(', '));
  } catch (e) { console.log('  ' + t + ' -> error ' + e.message); }
}
// busca el bloque en cualquier columna de texto de cualquier tabla
for (const t of tablas) {
  let nombres = [];
  try { nombres = db.prepare("select name from pragma_table_info('" + t + "')").all().map((r) => r.name); } catch { continue; }
  for (const c of nombres) {
    try {
      const r = db.prepare('select count(*) as n from ' + t + " where cast(" + c + " as text) like '%Para escuchar%'").get();
      if (r && r.n > 0) console.log('  COINCIDENCIAS en ' + t + '.' + c + ': ' + r.n);
    } catch {}
  }
}
db.close();
