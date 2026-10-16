import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
const src = 'C:\\Aegis-Proyects\\state\\data\\sessions\\sessions.db';
const tmp = 'C:\\Aegis-Proyects\\tmp\\qc2.db';
for (const ext of ['', '-wal', '-shm']) { try { copyFileSync(src + ext, tmp + ext); } catch (e) {} }
const db = new DatabaseSync(tmp, { readOnly: true });
const ult = db.prepare('SELECT id, name, created_at, provider_name FROM sessions ORDER BY rowid DESC LIMIT 10').all();
const out = ult.map((s) => ({ id: s.id, nombre: s.name, creado: String(s.created_at).slice(0, 19), prov: s.provider_name, msgs: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(s.id).n }));
console.log(JSON.stringify(out, null, 0));
