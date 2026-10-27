// Barrido de confirmaciones muertas: los `actionRequired::toolConfirmation` que nunca recibieron su
// `toolConfirmationResponse` corresponden a turnos cuyo proceso ya no existe. Escribir la respuesta
// como `Cancel` deja el registro consistente y hace que el indice de pendientes deje de reportarlas.
//
// Uso:  node --experimental-sqlite tools/sweep-pending.mjs           (dry run)
//       node --experimental-sqlite tools/sweep-pending.mjs --apply    (escribe, con backup previo)
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

const raiz = process.env.AEGIS_PATH_ROOT || 'C:/Aegis-Proyects/state';
const dbPath = join(raiz, 'data', 'sessions', 'sessions.db');
const aplicar = process.argv.includes('--apply');

const PIDE = /"actionType"\s*:\s*"toolConfirmation"\s*,\s*"[^"]+"\s*:\s*"([^"]+)"/g;
const PIDE_ALT = /"id"\s*:\s*"([^"]+)"\s*,\s*"[^"]+"\s*:\s*"[^"]*"\s*,\s*"actionType"\s*:\s*"toolConfirmation"/g;
const RESPONDE = /"actionType"\s*:\s*"toolConfirmationResponse"\s*,\s*"[^"]+"\s*:\s*"([^"]+)"/g;

const db = new DatabaseSync(dbPath, { readOnly: !aplicar });

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
  const estado = porSesion.get(fila.session_id) || { pide: new Map(), responde: new Set(), ultimo: 0 };
  for (const re of [PIDE, PIDE_ALT]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cuerpo)) !== null) {
      if (!estado.pide.has(m[1])) estado.pide.set(m[1], fila.created_timestamp || 0);
    }
  }
  RESPONDE.lastIndex = 0;
  let r;
  while ((r = RESPONDE.exec(cuerpo)) !== null) estado.responde.add(r[1]);
  estado.ultimo = Math.max(estado.ultimo, fila.created_timestamp || 0);
  porSesion.set(fila.session_id, estado);
}

const victima = [];
for (const [sessionId, estado] of porSesion) {
  for (const [id, ts] of estado.pide) {
    if (!estado.responde.has(id)) victima.push({ sessionId, id, ts });
  }
}

console.log(`modo: ${aplicar ? 'APLICAR' : 'dry run'}`);
console.log(`sesiones con pendientes: ${porSesion.size}`);
console.log(`confirmaciones sin respuesta: ${victima.length}`);
for (const v of victima.slice(0, 10)) console.log(`  ${v.sessionId}  ${v.id}`);

if (!aplicar) {
  console.log('\nSin --apply no se escribe nada.');
  process.exit(0);
}

const backup = `${dbPath}.bak-sweep-${Date.now()}`;
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`backup: ${backup}`);

const insertar = db.prepare(
  `insert into messages (session_id, role, content_json, created_timestamp, timestamp)
   values (?, 'user', ?, ?, ?)`,
);
const ahora = Math.floor(Date.now() / 1000);
let escritas = 0;
db.exec('BEGIN IMMEDIATE');
try {
  for (const v of victima) {
    const contenido = JSON.stringify([
      {
        type: 'actionRequired',
        data: { actionType: 'toolConfirmationResponse', id: v.id, permission: 'cancel' },
      },
    ]);
    insertar.run(v.sessionId, contenido, ahora, ahora);
    escritas += 1;
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('rollback:', e && e.message);
  process.exit(1);
}
console.log(`respuestas cancel escritas: ${escritas}`);
