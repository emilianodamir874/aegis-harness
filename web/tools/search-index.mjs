import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
const DB = process.env.AEGIS_SESSIONS_DB || "C:/Aegis-Proyects/state/data/sessions/sessions.db";
const OPEN = "";
const CLOSE = "";
const MAX_QUERY_CHARS = 200;
const ROW_CAP = 400;
const argv = process.argv.slice(2);
const argStr = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? String(argv[i + 1]) : null;
};
const argNum = (name, def, min, max) => {
  const raw = argStr(name);
  if (raw === null) return def;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : def;
};
const queryRaw = String(argStr("--query") || "").slice(0, MAX_QUERY_CHARS);
const limit = argNum("--limit", 20, 1, 50);
const perSession = argNum("--per-session", 3, 1, 10);
const out = {
  query: queryRaw,
  generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
  limit,
  perSession,
  mode: "all",
  results: [],
  totalSessions: 0,
  totalMatches: 0,
  truncated: false
};
function terminos(texto) {
  const vistos = /* @__PURE__ */ new Set();
  for (const t of texto.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []) {
    if (t.length >= 2) vistos.add(t);
  }
  return [...vistos].slice(0, 12);
}
function ftsExpr(ts) {
  return ts.map((t) => `"${t}"*`).join(" AND ");
}
function plegar(s) {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
try {
  if (!existsSync(DB)) throw new Error("no existe la base: " + DB);
  const db = new DatabaseSync("file:" + DB + "?mode=ro", { readOnly: true });
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const ts = terminos(queryRaw);
  if (!ts.length) {
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }
  const tieneVista = all("select name from sqlite_master where type = 'view' and name = 'v_visible_messages'").length > 0;
  out.visibility = tieneVista ? "view" : "inline";
  const FROM_MESSAGES = tieneVista ? "v_visible_messages m" : "messages m";
  const WHERE_VISIBLE = tieneVista ? "" : "and coalesce(json_extract(m.metadata_json, '$.userVisible'), 1) != 0 and s.session_type in ('user', 'scheduled', 'acp')";
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
  const buscar = () => {
    try {
      return all(SELECT, ftsExpr(ts));
    } catch (e) {
      out.ftsError = String(e.message || e).slice(0, 200);
      return [];
    }
  };
  const filas = buscar();
  const porSesion = /* @__PURE__ */ new Map();
  let totalMatches = 0;
  for (const f of filas) {
    totalMatches++;
    const id = String(f.session_id);
    let g = porSesion.get(id);
    if (!g) {
      if (porSesion.size >= limit) {
        out.truncated = true;
        continue;
      }
      g = { row: f, matches: [] };
      porSesion.set(id, g);
    }
    if (g.matches.length < perSession) {
      g.matches.push({
        role: String(f.role || ""),
        ts: Number(f.created_timestamp) || 0,
        snippet: String(f.snip || "")
      });
    }
  }
  const q = plegar(queryRaw.trim());
  if (q) {
    for (const s of all(
      `select id, name, working_dir, updated_at, archived_at from sessions
        where session_type in ('user', 'scheduled', 'acp')
        order by updated_at desc`
    )) {
      const id = String(s.id);
      const titulo = String(s.name || "");
      if (!plegar(titulo).includes(q)) continue;
      const previo = porSesion.get(id);
      if (previo) {
        previo.row.titleMatch = true;
        continue;
      }
      if (porSesion.size >= limit) {
        out.truncated = true;
        continue;
      }
      porSesion.set(id, { row: { ...s, session_id: id, titleMatch: true }, matches: [] });
    }
  }
  out.results = [...porSesion.values()].map(({ row, matches }) => ({
    sessionId: String(row.session_id || row.id),
    title: String(row.name || ""),
    cwd: row.working_dir ? String(row.working_dir) : "",
    updatedAt: row.updated_at ? String(row.updated_at) : "",
    archived: !!row.archived_at,
    titleMatch: !!row.titleMatch,
    matches
  }));
  out.totalSessions = out.results.length;
  out.totalMatches = totalMatches;
} catch (e) {
  out._error = String(e && e.message || e).slice(0, 300);
}
process.stdout.write(JSON.stringify(out));
