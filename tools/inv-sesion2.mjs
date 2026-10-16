import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const sid = '20261012_5';
const db = new DatabaseSync('C:/Aegis-Proyects/tmp/sessions-inv.db', { readOnly: true });
console.log('== firmas de corte en la base ==');
console.log('  assistant con contenido vacio []: ' + db.prepare("select count(*) as n from messages where session_id=? and role='assistant' and trim(cast(content_json as text))='[]'").get(sid).n);
console.log('  mensajes con "interrumpido": ' + db.prepare("select count(*) as n from messages where session_id=? and cast(content_json as text) like '%interrumpid%'").get(sid).n);
console.log('  mensajes con "Se cortó/corto la conexión": ' + db.prepare("select count(*) as n from messages where session_id=? and (cast(content_json as text) like '%conexion%' or cast(content_json as text) like '%conexión%')").get(sid).n);
console.log('  compactaciones (usage_ledger): ' + db.prepare('select count(*) as n from usage_ledger where session_id=? and is_compaction=1').get(sid).n);
console.log('  eventos de uso totales: ' + db.prepare('select count(*) as n from usage_ledger where session_id=?').get(sid).n);
console.log('  -- por dia (assistant vacios / totales) --');
for (const r of db.prepare("select substr(timestamp,1,10) as d, count(*) as total, sum(case when trim(cast(content_json as text))='[]' then 1 else 0 end) as vacios from messages where session_id=? and role='assistant' group by d order by d desc limit 8").all(sid)) console.log('    ' + r.d + ': ' + r.vacios + ' vacios de ' + r.total);
console.log('  -- ultimos 8 vacios --');
for (const r of db.prepare("select id, timestamp from messages where session_id=? and role='assistant' and trim(cast(content_json as text))='[]' order by id desc limit 8").all(sid)) console.log('    [' + r.id + '] ' + r.timestamp);
console.log('  -- errores guardados como texto (ultimos 6) --');
for (const r of db.prepare("select id, role, timestamp, substr(cast(content_json as text),1,300) as t from messages where session_id=? and (cast(content_json as text) like '%Error:%' or cast(content_json as text) like '%429%' or cast(content_json as text) like '%503%' or cast(content_json as text) like '%RESOURCE_EXHAUSTED%' or cast(content_json as text) like '%quota%') order by id desc limit 6").all(sid)) console.log('    [' + r.id + '] ' + r.role + ' ' + String(r.timestamp).slice(5, 19) + ' : ' + r.t.replace(/\s+/g, ' ').slice(0, 240));
db.close();

console.log('== estructura de los logs de request (para saber donde mirar) ==');
const dirs = ['C:/Aegis-Proyects/state/data/logs', 'C:/Aegis-Proyects/state/state/logs'];
let files = [];
for (const d of dirs) if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.startsWith('llm_request') && f.endsWith('.jsonl')) { const p = d + '/' + f; files.push({ p, m: fs.statSync(p).mtimeMs, s: fs.statSync(p).size }); }
files.sort((a, b) => b.m - a.m);
const linea = fs.readFileSync(files[0].p, 'utf8').split('\n').filter(Boolean)[0];
try {
  const j = JSON.parse(linea);
  console.log('  claves de nivel 1: ' + Object.keys(j).join(', '));
  const planas = JSON.stringify(j).match(/"[a-z_]*(error|finish|stop|reason|status|session)[a-z_]*":/gi);
  console.log('  claves con error/finish/stop/reason/status/session: ' + JSON.stringify([...new Set(planas || [])].slice(0, 14)));
} catch (e) { console.log('  no pude parsear: ' + e.message); }
console.log('== errores recientes en los logs (busco por texto) ==');
let hits = 0;
for (const f of files.slice(0, 4)) {
  const lineas = fs.readFileSync(f.p, 'utf8').split('\n').filter(Boolean);
  for (const l of lineas) {
    if (!/'20261012_5'|20261012_5/.test(l)) continue;
    const m = l.match(/"?(finish_reason|error|status|stop_reason|reason)"?\s*:\s*"?([^",}]{1,80})/gi);
    if (m && m.length) { hits++; if (hits < 8) console.log('  ' + f.p.split('/').pop() + ' -> ' + [...new Set(m)].slice(0, 4).join(' | ')); }
  }
}
console.log('  lineas con esa sesion y algo de error/estado: ' + hits);
