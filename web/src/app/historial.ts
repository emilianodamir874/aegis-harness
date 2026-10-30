/* Historial de prompts del composer (↑ / ↓), por sesión.
 *
 * Claude Code y claude.ai recorren lo que ya escribiste con la flecha arriba. Acá no existía: ArrowUp
 * sólo se usaba en combos y menús. La regla es la misma que en un shell: la flecha navega SOLO si el
 * cursor está en el borde (arriba en la primera posición, abajo en la última) y no hay selección, así
 * editar un prompt multilínea sigue funcionando.
 *
 * Se guarda en localStorage con el id de la sesión: es preferencia de este navegador, no del proceso,
 * y sobrevive a recargas. El texto se recorta a 8000 caracteres y la pila a 50 entradas.
 */
const CLAVE = 'aegis.prompts';
const MAX = 50;
const MAX_CHARS = 8000;

type Pila = { items: string[]; cursor: number; borrador: string };

let pila: Pila = { items: [], cursor: -1, borrador: '' };
let sidActual = '';

function leerTodo(): Record<string, string[]> {
  try {
    const crudo = JSON.parse(localStorage.getItem(CLAVE) || '{}') as Record<string, unknown>;
    const salida: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(crudo)) {
      if (Array.isArray(v)) salida[k] = v.filter((x): x is string => typeof x === 'string').slice(-MAX);
    }
    return salida;
  } catch { return {}; }
}

function escribirTodo(todo: Record<string, string[]>): void {
  try { localStorage.setItem(CLAVE, JSON.stringify(todo)); } catch { /* cuota llena: no es crítico */ }
}

export function cambiarSesion(sessionId: string): void {
  if (sessionId === sidActual) return;
  sidActual = sessionId;
  const items = sessionId ? (leerTodo()[sessionId] || []) : [];
  pila = { items, cursor: items.length, borrador: '' };
}

export function guardar(sessionId: string, texto: string): void {
  const limpio = (texto || '').trim().slice(0, MAX_CHARS);
  if (!limpio) return;
  if (sessionId !== sidActual) cambiarSesion(sessionId);
  // Repetir el mismo prompt no llena la pila de duplicados consecutivos.
  if (pila.items[pila.items.length - 1] !== limpio) {
    pila.items.push(limpio);
    if (pila.items.length > MAX) pila.items.shift();
    const todo = leerTodo();
    todo[sessionId] = pila.items;
    escribirTodo(todo);
  }
  pila.cursor = pila.items.length;
  pila.borrador = '';
}

/** Devuelve el texto a poner en el composer, o null si no hay nada que hacer. */
export function atras(actual: string): string | null {
  if (!pila.items.length) return null;
  if (pila.cursor === pila.items.length) pila.borrador = actual;
  if (pila.cursor <= 0) return null;
  pila.cursor--;
  return pila.items[pila.cursor] ?? null;
}

export function adelante(): string | null {
  if (pila.cursor >= pila.items.length) return null;
  pila.cursor++;
  if (pila.cursor === pila.items.length) return pila.borrador;
  return pila.items[pila.cursor] ?? null;
}

export function total(): number { return pila.items.length; }
