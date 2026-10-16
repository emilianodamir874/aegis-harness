import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
const s = 'C:/Aegis-Proyects/state/data/sessions/sessions.db';
const t = 'C:/Aegis-Proyects/tmp/rc.db';
for (const e of ['', '-wal', '-shm']) { try { copyFileSync(s + e, t + e); } catch (err) {} }
const db = new DatabaseSync(t, { readOnly: true });
const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
const ult = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 8').all('20261016_9');
const out = ult.map((m) => {
  const txt = String(m.content_json || '');
  const i = txt.indexOf('omitidos del replay');
  return { rowid: m.rowid, rol: m.role || m.message_type || '?', bytes: txt.length, tieneMarca: i >= 0, alrededor: i >= 0 ? txt.slice(Math.max(0, i - 90), i + 60).replace(/\n/g, ' ') : null, inicio: txt.slice(0, 70).replace(/\n/g, ' ') };
});
console.log(JSON.stringify({ cols: cols.slice(0, 12), out }, null, 1));
