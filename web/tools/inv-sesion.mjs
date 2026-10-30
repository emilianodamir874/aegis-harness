import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const sid = '20261012_5';
const orig = 'C:/Aegis-Proyects/state/data/sessions/sessions.db';
const copia = 'C:/Aegis-Proyects/tmp/sessions-inv.db';
fs.copyFileSync(orig, copia);
const db = new DatabaseSync(copia, { readOnly: true });
const s = db.prepare('select id, name, session_type, provider_name, model_config_json, aegis_mode, created_at, updated_at, total_tokens, input_tokens, output_tokens, accumulated_total_tokens from sessions where id = ?').get(sid);
if (!s) {
  console.log('NO existe esa sesion. Parecidas:');
  for (const r of db.prepare("select id, name from sessions where id like ? or name like ? limit 10").all('20261012%', '%' + sid + '%')) console.log('  ' + r.id + ' | ' + r.name);
  db.close(); process.exit(0);
}
console.log('SESION ' + s.id + ' | ' + s.name);
console.log('  proveedor: ' + s.provider_name + ' | modo: ' + s.aegis_mode);
console.log('  modelo: ' + s.model_config_json);
console.log('  creada ' + s.created_at + ' | ultima actividad ' + s.updated_at);
console.log('  mensajes: ' + db.prepare('select count(*) as n from messages where session_id = ?').get(sid).n + ' | tokens totales acumulados: ' + s.accumulated_total_tokens + ' (in ' + s.accumulated_input_tokens + ' / out ' + s.accumulated_output_tokens + ')');
const porRol = db.prepare('select role, count(*) as n from messages where session_id = ? group by role').all(sid);
console.log('  por rol: ' + JSON.stringify(porRol));
console.log('--- ultimos 14 mensajes ---');
const msgs = db.prepare('select id, role, content_json, timestamp, tokens from messages where session_id = ? order by id desc limit 14').all(sid).reverse();
for (const m of msgs) {
  let txt = '';
  try { const c = JSON.parse(m.content_json); txt = typeof c === 'string' ? c : JSON.stringify(c); } catch { txt = String(m.content_json); }
  txt = txt.replace(/\\n/g, ' ').replace(/\s+/g, ' ').slice(0, 190);
  console.log('  [' + m.id + '] ' + m.role + ' ' + String(m.timestamp).slice(11, 19) + ' (' + m.tokens + ' tk): ' + txt);
}
console.log('--- mensajes que huelen a corte/error ---');
const cortes = db.prepare("select id, role, timestamp, substr(cast(content_json as text),1,220) as t from messages where session_id = ? and (cast(content_json as text) like '%interrumpid%' or cast(content_json as text) like '%cortó%' or cast(content_json as text) like '%corto%' or cast(content_json as text) like '%Error%' or cast(content_json as text) like '%error%' or cast(content_json as text) like '%detenid%' or cast(content_json as text) like '%No se pudo%') order by id desc limit 12").all(sid);
for (const c of cortes) console.log('  [' + c.id + '] ' + c.role + ' ' + String(c.timestamp).slice(11, 19) + ' : ' + c.t.replace(/\s+/g, ' ').slice(0, 200));
console.log('--- ledger de uso (ultimas 12) ---');
for (const u of db.prepare('select created_timestamp, model, input_tokens, output_tokens, total_tokens, cost, is_compaction from usage_ledger where session_id = ? order by id desc limit 12').all(sid)) {
  console.log('  ' + u.created_timestamp + ' | ' + u.model + ' | in ' + u.input_tokens + ' out ' + u.output_tokens + ' (' + u.total_tokens + ') | costo ' + u.cost + ' | compactacion ' + u.is_compaction);
}
db.close();
