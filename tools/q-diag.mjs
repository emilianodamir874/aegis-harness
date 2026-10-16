import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
fs.copyFileSync("C:/Aegis-Proyects/state/data/sessions/sessions.db", "C:/Aegis-Proyects/tmp/sess-q.db");
const db = new DatabaseSync("C:/Aegis-Proyects/tmp/sess-q.db", { readOnly: true });
const rows = db.prepare("select session_id, id, role, timestamp, substr(cast(content_json as text),1,60) as t from messages where role='assistant' and timestamp > datetime('now','-30 minutes') order by id desc limit 12").all();
for (const r of rows) console.log("  " + r.timestamp + " [" + r.id + "] sesion " + r.session_id + " : " + r.t.replace(/\s+/g, " "));
const vacios = db.prepare("select count(*) as n from messages where role='assistant' and trim(cast(content_json as text))='[]' and timestamp > datetime('now','-30 minutes')").get();
console.log("  vacios en los ultimos 30 min: " + vacios.n);
db.close();
