import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
const src = 'C:\\Aegis-Proyects\\state\\data\\sessions\\sessions.db';
const tmp = 'C:\\Aegis-Proyects\\tmp\\prueba-prov.db';
for (const ext of ['', '-wal', '-shm']) { try { copyFileSync(src + ext, tmp + ext); } catch (e) {} }
const b = await chromium.launch();
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(1500);
await p.click('[data-id]');
await p.waitForTimeout(4000);
const res = await p.evaluate(async () => {
  const st = window.__aegisWeb.state;
  const sid = st.current.id;
  const antes = (st.current.configOptions || []).map((o) => o.id + '=' + o.currentValue).join(', ');
  let respuesta = null, error = null;
  try { const r = await window.__aegisWeb.rpc.request('session/set_config_option', { sessionId: sid, configId: 'provider', value: 'aegis' }); respuesta = (r.configOptions || []).map((o) => o.id + '=' + o.currentValue).join(', '); }
  catch (e) { error = String(e && e.message ? e.message : e); }
  return { sid, antes, respuesta, error };
});
await b.close();
await new Promise((r) => setTimeout(r, 2000));
const db = new DatabaseSync(tmp, { readOnly: true });
const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
const colId = cols.find((c) => c === 'id' || c === 'session_id' || /^session/i.test(c));
let fila = null, porId = null;
if (colId) { try { porId = db.prepare('SELECT * FROM sessions WHERE ' + colId + ' = ?').get(res.sid); } catch (e) { porId = { error: String(e.message) }; } }
const ultimas = db.prepare('SELECT * FROM sessions ORDER BY rowid DESC LIMIT 2').all();
const limpiar = (f) => { const o = {}; if (!f) return null; for (const [k, v] of Object.entries(f)) { if (/provider|model|effort|title|^id$|session/i.test(k)) o[k] = typeof v === 'string' ? v.slice(0, 260) : v; } return o; };
console.log(JSON.stringify({ res, colId, cols: cols.slice(0, 22), filaBuscada: limpiar(porId), ultimas: ultimas.map(limpiar) }, null, 1));
