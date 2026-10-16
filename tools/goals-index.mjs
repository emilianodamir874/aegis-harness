// goals-index.mjs - indice de objetivos (/goal y /grind) por conversacion, en JSON.
// El serve guarda el objetivo en extension_data ("goal.v0": {goal, grind}) pero NO lo expone por
// ACP, asi que se lee UNA COPIA de sessions.db en modo solo-lectura (nunca la base viva, que es
// un cuello de botella de concurrencia) y se completa con el ultimo /goal del historial.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Aegis-Proyects/state/data/sessions/sessions.db';
const COPIA = 'C:/Aegis-Proyects/tmp/goals-index.db';
const salida = { generado: new Date().toISOString(), items: [] };
const RE = /"text":"\/(goal|grind)[ \t]+([^"]+)"/i;

try {
  fs.mkdirSync(path.dirname(COPIA), { recursive: true });
  fs.copyFileSync(DB, COPIA);
  const db = new DatabaseSync(COPIA, { readOnly: true });
  const sesiones = db
    .prepare('select id, name, updated_at, archived_at, cast(extension_data as text) as ext from sessions order by updated_at desc limit 150')
    .all();
  const q = db.prepare("select cast(content_json as text) as t from messages where session_id = ? and role = 'user' and (cast(content_json as text) like '%\"text\":\"/goal%' or cast(content_json as text) like '%\"text\":\"/grind%') order by id desc limit 12");
  const items = [];
  for (const s of sesiones) {
    let activo = null;
    let tipo = 'goal';
    try {
      const j = JSON.parse(s.ext || '{}');
      const g = j['goal.v0'] || {};
      if (g.goal) { activo = String(g.goal); tipo = 'goal'; }
      else if (g.grind) { activo = String(g.grind); tipo = 'grind'; }
    } catch (e) {}
    let texto = activo;
    let estado = activo ? 'activo' : null;
    if (!activo) {
      for (const m of q.all(s.id)) {
        const mm = RE.exec(m.t || '');
        if (!mm) continue;
        const params = mm[2].trim();
        if (/^(off|clear|none)$/i.test(params)) break; // el ultimo comando fue limpiar: no hay objetivo
        texto = params;
        tipo = mm[1].toLowerCase();
        estado = 'cerrado';
        break;
      }
    }
    if (!texto || !estado) continue;
    items.push({ sid: s.id, nombre: s.name || '', texto: String(texto).slice(0, 400), tipo, estado, actualizado: s.updated_at, archivado: !!s.archived_at });
  }
  db.close();
  salida.items = items.sort((a, b) => String(b.actualizado).localeCompare(String(a.actualizado)));
} catch (e) {
  salida.error = String((e && e.message) || e);
}
process.stdout.write(JSON.stringify(salida));
