/* Variantes de la última respuesta (‹ 1/2 ›), al estilo de Claude.
 *
 * El botón de regenerar ya existía, pero borraba la respuesta anterior de la vista: volver a la
 * primera versión era imposible sin recargar y perder el turno. Acá se guarda el HTML de cada
 * respuesta que se reemplaza y se ofrece un conmutador en la fila del mensaje.
 *
 * LÍMITE HONESTO: esto es una vista local. El modelo recibe siempre la última; las variantes
 * anteriores quedaron fuera del contexto por el rewind (siguen en la sesión). El chip "local" lo
 * dice para que nadie crea que puede volver a preguntarle a una variante vieja.
 */
const CLAVE = 'aegis.variantes';
const MAX_POR_TURNO = 4;
const MAX_CHARS = 400_000;

type Turno = { variantes: string[]; idx: number };
type Store = Record<string, Turno[]>;

let sid = '';
let turnos: Turno[] = [];

function leer(): Store {
  try {
    const crudo = JSON.parse(localStorage.getItem(CLAVE) || '{}') as Store;
    return crudo && typeof crudo === 'object' ? crudo : {};
  } catch { return {}; }
}

function escribir(todo: Store): void {
  try { localStorage.setItem(CLAVE, JSON.stringify(todo)); } catch { /* cuota: se pierde el historial, no el turno */ }
}

export function cambiarSesion(sessionId: string): void {
  if (sessionId === sid) return;
  sid = sessionId;
  turnos = sessionId ? (leer()[sessionId] || []) : [];
}

/** Guarda la respuesta que se está por reemplazar. Devuelve el turno donde quedó. */
export function archivar(html: string): Turno | null {
  const limpio = (html || '').slice(0, MAX_CHARS);
  if (!limpio.trim()) return null;
  let turno = turnos[turnos.length - 1];
  if (!turno || turno.variantes[turno.idx] !== limpio) {
    turno = { variantes: [limpio], idx: 0 };
    turnos.push(turno);
    if (turnos.length > 200) turnos.shift();
  }
  return turno;
}

/** Registra la respuesta nueva de ese turno (la que acaba de escribir el modelo). */
export function agregar(html: string, turno: Turno | null): void {
  const limpio = (html || '').slice(0, MAX_CHARS);
  if (!turno || !limpio.trim()) return;
  if (!turno.variantes.includes(limpio)) {
    turno.variantes.push(limpio);
    if (turno.variantes.length > MAX_POR_TURNO) turno.variantes.shift();
  }
  turno.idx = turno.variantes.length - 1;
  if (sid) { const todo = leer(); todo[sid] = turnos; escribir(todo); }
}

export function actual(): Turno | null { return turnos[turnos.length - 1] || null; }

export function mover(dir: -1 | 1): { html: string; idx: number; total: number } | null {
  const turno = actual();
  if (!turno || turno.variantes.length < 2) return null;
  const idx = Math.min(turno.variantes.length - 1, Math.max(0, turno.idx + dir));
  if (idx === turno.idx) return null;
  turno.idx = idx;
  if (sid) { const todo = leer(); todo[sid] = turnos; escribir(todo); }
  return { html: turno.variantes[idx], idx, total: turno.variantes.length };
}

export function posicion(): { idx: number; total: number } | null {
  const turno = actual();
  return turno && turno.variantes.length > 1 ? { idx: turno.idx, total: turno.variantes.length } : null;
}
