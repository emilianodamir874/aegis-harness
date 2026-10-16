import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Aegis-Proyects/tmp/sessions-22.db', { readOnly: true });
const m = db.prepare("select id, content_json, timestamp from messages where session_id='20261015_22' and role='assistant' order by id desc limit 1").get();
let txt = '';
try {
  const c = JSON.parse(m.content_json);
  if (Array.isArray(c)) txt = c.map((b) => b.type === 'text' ? b.text : (b.type === 'thinking' ? '' : '')).filter(Boolean).join('\n');
  else txt = String(c);
} catch { txt = String(m.content_json); }
console.log('mensaje ' + m.id + ' | ' + m.timestamp + ' | ' + txt.length + ' caracteres de texto');
console.log(txt.slice(0, 6000));
db.close();
