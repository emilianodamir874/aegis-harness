// Una sola semantica de visibilidad (fase 5): la regla del motor (v_visible_messages, migracion
// 21) tiene que dar el mismo conjunto que el predicado inline que replicaba la busqueda de la web.
//
// Compara conteos sobre el store real en solo lectura cuando el store ya tiene la vista (despues
// del swap que aplica la migracion) y, siempre, sobre una fixture con el mismo esquema para no
// depender de en que version esta el serve.
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync as exists } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = process.env.AEGIS_SESSIONS_DB || 'C:/Aegis-Proyects/state/data/sessions/sessions.db';

const VISIBLE_SQL = `select count(*) c
  from messages m join sessions s on s.id = m.session_id
 where coalesce(json_extract(m.metadata_json, '$.userVisible'), 1) != 0
   and s.session_type in ('user','scheduled','acp')`;
const VIEW_SQL = 'select count(*) c from v_visible_messages';

const fail = (m: string): never => { console.error('FAIL ' + m); process.exit(1); };
const check = (c: unknown, m: string): void => { if (!c) fail(m); };

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aegis-vis-'));
  const file = join(dir, 'sessions.db');
  const db = new DatabaseSync(file);
  db.exec(`
    create table sessions (id text primary key, name text, session_type text, working_dir text, updated_at text, archived_at text);
    create table messages (
      id integer primary key autoincrement, message_id text, session_id text not null,
      role text not null, content_json text not null, created_timestamp integer not null,
      timestamp timestamp default current_timestamp, tokens integer, metadata_json text
    );
    create view v_visible_messages as
      select m.* from messages m join sessions s on s.id = m.session_id
       where coalesce(json_extract(m.metadata_json, '$.userVisible'), 1) != 0
         and s.session_type in ('user','scheduled','acp');
  `);
  const insS = db.prepare('insert into sessions (id, name, session_type, working_dir, updated_at) values (?,?,?,?,?)');
  insS.run('s_user', 'De usuario', 'user', 'C:/x', '2026-10-20T10:00:00Z');
  insS.run('s_acp', 'ACP', 'acp', 'C:/x', '2026-10-20T10:00:00Z');
  insS.run('s_sched', 'Programada', 'scheduled', 'C:/x', '2026-10-20T10:00:00Z');
  insS.run('s_sub', 'Sub agente', 'sub_agent', 'C:/x', '2026-10-20T10:00:00Z');
  insS.run('s_internal', 'Interna', 'internal', 'C:/x', '2026-10-20T10:00:00Z');
  const insM = db.prepare('insert into messages (session_id, role, content_json, metadata_json, created_timestamp) values (?,?,?,?,?)');
  const msg = JSON.stringify([{ type: 'text', text: 'hola' }]);
  insM.run('s_user', 'user', msg, JSON.stringify({ userVisible: true }), 1);
  insM.run('s_user', 'assistant', msg, JSON.stringify({ userVisible: true }), 2);
  insM.run('s_user', 'assistant', msg, JSON.stringify({ userVisible: false }), 3);
  insM.run('s_user', 'assistant', msg, null, 4);
  insM.run('s_acp', 'user', msg, JSON.stringify({ userVisible: true }), 5);
  insM.run('s_sched', 'user', msg, null, 6);
  insM.run('s_sub', 'user', msg, JSON.stringify({ userVisible: true }), 7);
  insM.run('s_internal', 'user', msg, JSON.stringify({ userVisible: true }), 8);
  db.close();
  return file;
}

const dir = await mkdtemp(join(tmpdir(), 'aegis-vis-real-'));
try {
  // ---------- fixture: la regla es la misma y excluye lo que tiene que excluir ----------
  const f = await fixture();
  const fx = new DatabaseSync('file:' + f.replace(/\\/g, '/') + '?mode=ro', { readOnly: true });
  const vista = (fx.prepare(VIEW_SQL).get() as any).c;
  const inline = (fx.prepare(VISIBLE_SQL).get() as any).c;
  check(vista === inline, 'fixture: vista (' + vista + ') != predicado inline (' + inline + ')');
  check(vista === 5, 'fixture: se esperaban 5 mensajes visibles, hay ' + vista);
  const porTipo = fx.prepare('select s.session_type t, count(*) c from v_visible_messages m join sessions s on s.id=m.session_id group by 1').all() as any[];
  check(!porTipo.some((r) => r.t === 'sub_agent' || r.t === 'internal'), 'fixture: la vista no debe incluir sub_agent ni internas: ' + JSON.stringify(porTipo));
  const oculto = fx.prepare("select count(*) c from v_visible_messages where json_extract(metadata_json,'$.userVisible') = 0").get() as any;
  check(oculto.c === 0, 'fixture: userVisible=false no puede aparecer en la vista');
  fx.close();

  // ---------- store real, si ya tiene la vista ----------
  if (exists(DB)) {
    const real = new DatabaseSync('file:' + DB.replace(/\\/g, '/') + '?mode=ro', { readOnly: true });
    const tieneVista = (real.prepare("select count(*) c from sqlite_master where type='view' and name='v_visible_messages'").get() as any).c > 0;
    if (tieneVista) {
      const rv = (real.prepare(VIEW_SQL).get() as any).c;
      const ri = (real.prepare(VISIBLE_SQL).get() as any).c;
      check(rv === ri, 'store real: vista (' + rv + ') != inline (' + ri + ')');
      console.log('store real: ' + rv + ' mensajes visibles, vista = predicado inline');
    } else {
      console.log('store real sin v_visible_messages todavia (la crea la migracion 21 en el proximo arranque del serve): se valido sobre la fixture');
    }
    real.close();
  } else {
    console.log('sin store real en ' + DB + ': se valido sobre la fixture');
  }

  console.log('PASS visibilidad: vista y predicado inline coinciden');
} finally {
  await rm(dir, { recursive: true, force: true });
}
