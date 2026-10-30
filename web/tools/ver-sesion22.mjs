import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const sid = '20261015_22';
const orig = 'C:/Aegis-Proyects/state/data/sessions/sessions.db';
const copia = 'C:/Aegis-Proyects/tmp/sessions-22.db';
fs.copyFileSync(orig, copia);
const db = new DatabaseSync(copia, { readOnly: true });
const s = db.prepare('select id, name, provider_name, model_config_json, created_at, updated_at from sessions where id = ?').get(sid);
if (!s) { console.log('NO existe la sesion'); db.close(); process.exit(0); }
console.log('SESION ' + s.id + ' | ' + s.name);
console.log('  proveedor ' + s.provider_name + ' | modelo ' + s.model_config_json);
console.log('  ultima actividad ' + s.updated_at + ' | mensajes ' + db.prepare('select count(*) as n from messages where session_id=?').get(sid).n);
const msgs = db.prepare('select id, role, content_json, timestamp from messages where session_id = ? order by id desc limit 4').all(sid).reverse();
for (const m of msgs) {
  let partes = [];
  try {
    const c = JSON.parse(m.content_json);
    if (typeof c === 'string') partes.push(c);
    else if (Array.isArray(c)) for (const b of c) {
      if (b && b.type === 'text' && b.text) partes.push('[TEXTO] ' + b.text);
      else if (b && b.type === 'thinking' && b.thinking) partes.push('[PENSAMIENTO] ' + b.thinking);
      else if (b && b.type === 'toolRequest') partes.push('[TOOL ' + (b.toolCall && b.toolCall.value && b.toolCall.value.name) + ']');
      else if (b && b.type === 'toolResponse') partes.push('[RESULTADO]');
    }
  } catch (e) { partes.push('(no parseable)'); }
  const txt = partes.join('\n').slice(0, 1800);
  console.log('--- [' + m.id + '] ' + m.role + ' ' + m.timestamp + ' ---');
  console.log(txt);
}
db.close();
