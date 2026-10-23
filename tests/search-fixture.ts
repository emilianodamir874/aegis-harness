// Fixture de sessions.db para las pruebas de busqueda: mismo esquema que usa el hub para
// lo que consulta el indice (sessions, messages, messages_fts) y los mismos triggers/MATCH.
// Se crea en un directorio temporal; nunca toca el store real.
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type FixtureSession = {
  id: string;
  name?: string;
  type?: 'user' | 'acp' | 'scheduled' | 'sub_agent';
  cwd?: string;
  updatedAt?: string;
  archivedAt?: string | null;
};

export type FixtureMessage = {
  session: string;
  role?: 'user' | 'assistant';
  text: string;
  /** por defecto true; false = mensaje interno (el hub lo marca userVisible:false) */
  visible?: boolean;
  ts?: number;
};

export async function createSearchDb(dir: string, sessions: FixtureSession[], messages: FixtureMessage[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'sessions.db');
  const db = new DatabaseSync(file);
  db.exec(`
    create table sessions (
      id text primary key,
      name text,
      session_type text,
      working_dir text,
      updated_at text,
      archived_at text
    );
    create table messages (
      id integer primary key autoincrement,
      session_id text,
      role text,
      content_json text,
      metadata_json text,
      created_timestamp integer
    );
    create virtual table messages_fts using fts5(row_id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
    create trigger messages_fts_ai after insert on messages begin
      insert into messages_fts(row_id, text)
      values (new.id, coalesce((select group_concat(json_extract(value, '$.text'), ' ') from json_each(new.content_json) where json_extract(value, '$.type') = 'text'), ''));
    end;
  `);
  const insSession = db.prepare(
    'insert into sessions (id, name, session_type, working_dir, updated_at, archived_at) values (?, ?, ?, ?, ?, ?)',
  );
  for (const s of sessions) {
    insSession.run(
      s.id,
      s.name || '',
      s.type || 'acp',
      s.cwd || 'C:/mock',
      s.updatedAt || new Date().toISOString(),
      s.archivedAt === undefined ? null : s.archivedAt,
    );
  }
  const insMsg = db.prepare(
    'insert into messages (session_id, role, content_json, metadata_json, created_timestamp) values (?, ?, ?, ?, ?)',
  );
  let ts = 1_760_000_000;
  db.exec('begin');
  for (const m of messages) {
    ts += 1;
    insMsg.run(
      m.session,
      m.role || 'user',
      JSON.stringify([{ type: 'text', text: m.text }]),
      JSON.stringify({ userVisible: m.visible === false ? false : true }),
      m.ts || ts,
    );
  }
  db.exec('commit');
  db.close();
  return file;
}

/** Inserta una coleccion grande para medir tiempos (no se usa en pruebas de contenido). */
export async function createLargeDb(dir: string, sessions = 200, perSession = 100): Promise<string> {
  const sess: FixtureSession[] = [];
  const msgs: FixtureMessage[] = [];
  for (let s = 0; s < sessions; s++) {
    const id = 'big_' + s;
    sess.push({ id, name: 'Sesión grande ' + s, updatedAt: new Date(1_760_000_000_000 + s * 1000).toISOString() });
    for (let m = 0; m < perSession; m++) {
      msgs.push({
        session: id,
        role: m % 2 ? 'assistant' : 'user',
        text: `mensaje ${m} de la sesion ${s} con relleno para el indice de texto completo numero ${m * 7 + s}`,
      });
    }
  }
  // Una aguja unica para comprobar que la busqueda no pierde nada en una base grande.
  msgs.push({ session: 'big_7', role: 'user', text: 'la aguja escarlata aparece una sola vez' });
  return createSearchDb(dir, sess, msgs);
}
