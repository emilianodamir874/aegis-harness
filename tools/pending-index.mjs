// Sesiones con una confirmacion de tool pedida y nunca respondida.
//
// El mensaje `actionRequired` queda persistido en el store; si no tiene su
// `toolConfirmationResponse` con el mismo id, la sesion esta esperando algo. Cuando el serve se
// reinicia esa espera muere con el proceso y la tarjeta no vuelve: este indice es lo unico que lo
// hace visible.
//
// Cuidado con el patron: `"toolConfirmation"` es prefijo de `"toolConfirmationResponse"`, asi que
// el pedido se ancla con la coma que lo sigue. Sin eso, cada respuesta se contaba como un pedido
// nuevo y el numero de sesiones trabadas salia inflado.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const raiz = process.env.AEGIS_PATH_ROOT || 'C:/Aegis-Proyects/state';
const dbPath = join(raiz, 'data', 'sessions', 'sessions.db');

const PIDE = /"actionType"\s*:\s*"toolConfirmation"\s*,\s*"[^"]+"\s*:\s*"([^"]+)"/g;
const RESPONDE = /"actionType"\s*:\s*"toolConfirmationResponse"\s*,\s*"[^"]+"\s*:\s*"([^"]+)"/g;

export function leerPendientes(db) {
  const porSesion = new Map();
  const filas = db
    .prepare(
      `select session_id, content_json, created_timestamp
         from messages where content_json like '%toolConfirmation%'
        order by created_timestamp asc`,
    )
    .all();

  for (const fila of filas) {
    const cuerpo = fila.content_json || '';
    const estado =
      porSesion.get(fila.session_id) || { pide: new Set(), responde: new Set(), ultimo: 0 };

    PIDE.lastIndex = 0;
    let m;
    while ((m = PIDE.exec(cuerpo)) !== null) estado.pide.add(m[1]);

    RESPONDE.lastIndex = 0;
    let r;
    while ((r = RESPONDE.exec(cuerpo)) !== null) estado.responde.add(r[1]);

    estado.ultimo = Math.max(estado.ultimo, fila.created_timestamp || 0);
    porSesion.set(fila.session_id, estado);
  }

  const salida = [];
  for (const [sessionId, estado] of porSesion) {
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
  return salida;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('pending-index.mjs')) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const sessions = leerPendientes(db);
  process.stdout.write(JSON.stringify({ sessions, total: sessions.length }));
}
