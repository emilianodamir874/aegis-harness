// Sesiones con una confirmacion de tool pedida y nunca respondida.
// El mensaje `actionRequired` queda persistido en el store; si no tiene su
// `toolConfirmationResponse` con el mismo id, la sesion esta esperando algo. Cuando el serve se
// reinicia, esa espera muere con el proceso y la tarjeta no vuelve: este indice es lo unico que lo
// hace visible.
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.env.AEGIS_PATH_ROOT
  ? `${process.env.AEGIS_PATH_ROOT.replace(/[\\/]+$/, '')}/data/sessions/sessions.db`
  : 'C:/Aegis-Proyects/state/data/sessions/sessions.db';

const db = new DatabaseSync(dbPath, { readOnly: true });

const PIDE = /"actionType"\s*:\s*"toolConfirmation"[^}]*?"id"\s*:\s*"([^"]+)"/g;
const RESPONDE = /"actionType"\s*:\s*"toolConfirmationResponse"\s*,\s*"id"\s*:\s*"([^"]+)"/g;
const PIDE_ALT = /"id"\s*:\s*"([^"]+)"[^}]*?"actionType"\s*:\s*"toolConfirmation"/g;

const pendientes = new Map();

const rows = db
  .prepare(
    `select session_id, content_json, created_timestamp
       from messages
      where content_json like '%toolConfirmation%'
      order by created_timestamp asc`,
  )
  .all();

for (const row of rows) {
  const cuerpo = row.content_json || '';
  const pedidos = new Set();
  for (const re of [PIDE, PIDE_ALT]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cuerpo)) !== null) pedidos.add(m[1]);
  }
  if (!pedidos.size) continue;

  const estado = pendientes.get(row.session_id) || { pide: new Set(), responde: new Set(), ultimo: 0 };
  RESPONDE.lastIndex = 0;
  let r;
  while ((r = RESPONDE.exec(cuerpo)) !== null) estado.responde.add(r[1]);
  for (const id of pedidos) estado.pide.add(id);
  estado.ultimo = row.created_timestamp || estado.ultimo;
  pendientes.set(row.session_id, estado);
}

const salida = [];
for (const [sessionId, estado] of pendientes) {
  const sinRespuesta = [...estado.pide].filter((id) => !estado.responde.has(id));
  if (!sinRespuesta.length) continue;
  salida.push({
    sessionId,
    pendientes: sinRespuesta.length,
    ultimos: sinRespuesta.slice(-3),
    ultimo: estado.ultimo,
  });
}

salida.sort((a, b) => (b.ultimo || 0) - (a.ultimo || 0));
process.stdout.write(JSON.stringify({ sessions: salida, total: salida.length }));
