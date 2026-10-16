// goals-index.mjs - objetivos (/goal y /grind) de una conversacion (o de todas), en JSON.
// El serve guarda el estado actual en extension_data ("goal.v0": {goal, grind}) pero NO lo expone
// por ACP, asi que se lee UNA COPIA de sessions.db en modo solo-lectura (nunca la base viva, que es
// un cuello de botella de concurrencia).
//   node --experimental-sqlite goals-index.mjs <sid>   -> solo ese chat: historial de objetivos
//   node --experimental-sqlite goals-index.mjs          -> todos los chats (ultimo objetivo de cada uno)
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Aegis-Proyects/state/data/sessions/sessions.db';
const COPIA = 'C:/Aegis-Proyects/tmp/goals-index.db';
const SID = process.argv[2] || '';
const RE = /"text":"\/(goal|grind)[ \t]+([^"]+)"/i;
const salida = { generado: new Date().toISOString(), sid: SID, items: [] };

try {
  fs.mkdirSync(path.dirname(COPIA), { recursive: true });
  fs.copyFileSync(DB, COPIA);
  const db = new DatabaseSync(COPIA, { readOnly: true });
  const meta = db.prepare('select id, name, updated_at, archived_at, cast(extension_data as text) as ext from sessions where id = ?');
  const metas = db.prepare('select id, name, updated_at, archived_at, cast(extension_data as text) as ext from sessions order by updated_at desc limit 150');
  const goalsDe = db.prepare("select cast(content_json as text) as t, timestamp from messages where session_id = ? and role = 'user' and (cast(content_json as text) like '%\"text\":\"/goal%' or cast(content_json as text) like '%\"text\":\"/grind%') order by id asc");

  const estadoDe = (ext) => {
    try {
      const g = (JSON.parse(ext || '{}'))['goal.v0'] || {};
      if (g.goal) return { texto: String(g.goal), tipo: 'goal' };
      if (g.grind) return { texto: String(g.grind), tipo: 'grind' };
    } catch (e) {}
    return null;
  };

  if (SID) {
    const s = meta.get(SID);
    if (!s) throw new Error('sesion ' + SID + ' no encontrada');
    const activo = estadoDe(s.ext);
    salida.nombre = s.name || '';
    salida.actualizado = s.updated_at;
    salida.activo = activo ? activo.texto : null;
    salida.activoTipo = activo ? activo.tipo : null;
    const vistos = [];
    for (const m of goalsDe.all(SID)) {
      const mm = RE.exec(m.t || '');
      if (!mm) continue;
      const params = mm[2].trim();
      if (/^(off|clear|none)$/i.test(params)) continue; // limpiar no es un objetivo
      const texto = params.slice(0, 400);
      if (vistos.length && vistos[vistos.length - 1].texto === texto) continue; // repetido seguido
      vistos.push({ texto, tipo: mm[1].toLowerCase(), cuando: m.timestamp, activo: false });
    }
    // El estado vigente manda: si el extension_data tiene objetivo, ese es el activo (aunque el
    // texto no coincida con el ultimo del historial, p.ej. si se seteo por CLI en otro idioma).
    if (activo) {
      let marcado = false;
      for (let i = vistos.length - 1; i >= 0; i--) {
        if (vistos[i].texto === activo.texto) { vistos[i].activo = true; marcado = true; break; }
      }
      if (!marcado) vistos.push({ texto: activo.texto, tipo: activo.tipo, cuando: s.updated_at, activo: true });
    }
    salida.items = vistos.reverse(); // mas reciente primero
  } else {
    const items = [];
    for (const s of metas.all()) {
      const activo = estadoDe(s.ext);
      let texto = activo ? activo.texto : null;
      let tipo = activo ? activo.tipo : 'goal';
      let estado = activo ? 'activo' : null;
      if (!activo) {
        const ms = goalsDe.all(s.id);
        for (let i = ms.length - 1; i >= 0; i--) {
          const mm = RE.exec(ms[i].t || '');
          if (!mm) continue;
          const params = mm[2].trim();
          if (/^(off|clear|none)$/i.test(params)) break;
          texto = params;
          tipo = mm[1].toLowerCase();
          estado = 'cerrado';
          break;
        }
      }
      if (!texto || !estado) continue;
      items.push({ sid: s.id, nombre: s.name || '', texto: String(texto).slice(0, 400), tipo, estado, actualizado: s.updated_at, archivado: !!s.archived_at });
    }
    salida.items = items.sort((a, b) => String(b.actualizado).localeCompare(String(a.actualizado)));
  }
  db.close();
} catch (e) {
  salida.error = String((e && e.message) || e);
}
process.stdout.write(JSON.stringify(salida));
