// search-index — busqueda de texto completo sobre el historial de sesiones para la web.
//
// Por que existe: el cliente recibe titulos y _meta, asi que su buscador solo puede filtrar
// lo que ya tiene (titulos y ~50 sesiones paginadas). Buscar dentro de los mensajes necesita
// la base. El hub TIENE un contrato para esto (session/list con _meta.query), pero medido
// contra el store real (86k mensajes) no respondio en 240 s: `instr(LOWER(json_extract(...)))`
// escanea todos los mensajes y bloquea el pool. La base ya mantiene un indice FTS5
// (messages_fts, triggers del hub, tokenizer unicode61 remove_diacritics 2), asi que se
// consulta ese indice en un proceso aparte, en solo lectura, igual que stats-index.
//
// Uso:  node --experimental-sqlite tools/search-index.mjs --query "texto" [--limit 20] [--per-session 3]
// Salida: JSON por stdout. Errores como { "_error": "..." } con exit 0 (convencion del server).
// Marcas de coincidencia en el snippet: \u0001 (abre) y \u0002 (cierra); el cliente las
// convierte en <mark> creando nodos de texto, sin innerHTML.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const DB = process.env.AEGIS_SESSIONS_DB || 'C:/Aegis-Proyects/state/data/sessions/sessions.db';
const OPEN = '\u0001';
const CLOSE = '\u0002';
const MAX_QUERY_CHARS = 200;
const ROW_CAP = 400; // filas que se traen del indice antes de agrupar por sesion

type Fila = Record<string, any>;
const argv = process.argv.slice(2);
const argStr = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? String(argv[i + 1]) : null;
};
const argNum = (name: string, def: number, min: number, max: number): number => {
  const raw = argStr(name);
  if (raw === null) return def;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : def;
};

const queryRaw = String(argStr('--query') || '').slice(0, MAX_QUERY_CHARS);
const limit = argNum('--limit', 20, 1, 50);
const perSession = argNum('--per-session', 3, 1, 10);

const out: Record<string, any> = {
  query: queryRaw,
  generatedAt: new Date().toISOString(),
  limit,
  perSession,
  mode: 'all',
  results: [] as any[],
  totalSessions: 0,
  totalMatches: 0,
  truncated: false,
};

// Terminos: solo letras/numeros/underscore. Todo lo demas (comillas, ^, :, *, parentesis,
// NEAR) se descarta ANTES de armar el MATCH, asi una consulta malformada nunca llega a FTS5.
// Menos de 2 caracteres por termino no distingue nada y genera ruido.
function terminos(texto: string): string[] {
  const vistos = new Set<string>();
  for (const t of texto.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []) {
    if (t.length >= 2) vistos.add(t);
  }
  return [...vistos].slice(0, 12);
}

function ftsExpr(ts: string[]): string {
  return ts.map((t) => `"${t}"*`).join(' AND ');
}

// Titulos: 347 filas, se comparan en JS para que "revision" encuentre "Revisión" (LIKE de
// SQLite solo pliega ASCII). Mismo criterio que el filtro del cliente.
function plegar(s: unknown): string {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

try {
  if (!existsSync(DB)) throw new Error('no existe la base: ' + DB);
  const db = new DatabaseSync('file:' + DB + '?mode=ro', { readOnly: true });
  const all = (sql: string, ...p: any[]): Fila[] => db.prepare(sql).all(...p) as Fila[];

  const ts = terminos(queryRaw);
  if (!ts.length) {
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  // Visibilidad: la regla vive en el motor (vista v_visible_messages, migracion 21). Mientras el
  // store no tenga la vista (el serve que corre todavia es anterior), se usa el predicado inline
  // para no romper la busqueda; `visibility` en la salida dice cual de los dos camino se uso.
  const tieneVista = all("select name from sqlite_master where type = 'view' and name = 'v_visible_messages'").length > 0;
  out.visibility = tieneVista ? 'view' : 'inline';
  const FROM_MESSAGES = tieneVista ? 'v_visible_messages m' : 'messages m';
  const WHERE_VISIBLE = tieneVista
    ? ''
    : "and coalesce(json_extract(m.metadata_json, '$.userVisible'), 1) != 0 and s.session_type in ('user', 'scheduled', 'acp')";

  const SELECT = `
    select m.session_id, m.role, m.created_timestamp,
           s.name, s.working_dir, s.updated_at, s.archived_at,
           snippet(messages_fts, 1, char(1), char(2), '…', 18) snip,
           bm25(messages_fts) rank
      from messages_fts
      join ${FROM_MESSAGES} on m.id = messages_fts.row_id
      join sessions s on s.id = m.session_id
     where messages_fts match ?
       ${WHERE_VISIBLE}
     order by rank
     limit ${ROW_CAP}`;

  const buscar = (): Fila[] => {
    try {
      return all(SELECT, ftsExpr(ts));
    } catch (e) {
      // Un termino raro no debe tumbar la busqueda: si FTS5 rechaza la expresion, se
      // devuelve vacio (y el cliente mantiene su filtro local).
      out.ftsError = String((e as Error).message || e).slice(0, 200);
      return [];
    }
  };

  const filas = buscar();

  // Agrupar: una entrada por sesion, en orden de mejor rank (las filas ya vienen ordenadas),
  // hasta `perSession` coincidencias por sesion y `limit` sesiones.
  const porSesion = new Map<string, { row: Fila; matches: any[] }>();
  let totalMatches = 0;
  for (const f of filas) {
    totalMatches++;
    const id = String(f.session_id);
    let g = porSesion.get(id);
    if (!g) {
      if (porSesion.size >= limit) { out.truncated = true; continue; }
      g = { row: f, matches: [] };
      porSesion.set(id, g);
    }
    if (g.matches.length < perSession) {
      g.matches.push({
        role: String(f.role || ''),
        ts: Number(f.created_timestamp) || 0,
        snippet: String(f.snip || ''),
      });
    }
  }

  // Titulos que coinciden y no entraron por contenido (o que no tienen coincidencias visibles).
  const q = plegar(queryRaw.trim());
  if (q) {
    for (const s of all(
      `select id, name, working_dir, updated_at, archived_at from sessions
        where session_type in ('user', 'scheduled', 'acp')
        order by updated_at desc`,
    )) {
      const id = String(s.id);
      const titulo = String(s.name || '');
      if (!plegar(titulo).includes(q)) continue;
      const previo = porSesion.get(id);
      if (previo) { previo.row.titleMatch = true; continue; }
      if (porSesion.size >= limit) { out.truncated = true; continue; }
      porSesion.set(id, { row: { ...s, session_id: id, titleMatch: true }, matches: [] });
    }
  }

  out.results = [...porSesion.values()].map(({ row, matches }) => ({
    sessionId: String(row.session_id || row.id),
    title: String(row.name || ''),
    cwd: row.working_dir ? String(row.working_dir) : '',
    updatedAt: row.updated_at ? String(row.updated_at) : '',
    archived: !!row.archived_at,
    titleMatch: !!row.titleMatch,
    matches,
  }));
  out.totalSessions = out.results.length;
  out.totalMatches = totalMatches;
} catch (e) {
  out._error = String(((e as Error) && (e as Error).message) || e).slice(0, 300);
}

process.stdout.write(JSON.stringify(out));
