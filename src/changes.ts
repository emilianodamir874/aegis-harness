/* Cambios Git del directorio de la sesión, mostrados DENTRO del chat.
 *
 * Antes esto era un diálogo que se abría desde un botón del sidebar, o sea fuera de la
 * conversación: los cambios se leían en una ventana encima de todo y había que volver a abrirla
 * para ver el estado nuevo. Ahora es un bloque del propio transcript, al final, que se refresca
 * al terminar cada turno y cuando cambia la sesión.
 *
 * El cliente NUNCA manda la ruta: /changes.json valida el cwd permitido de la sesión antes de
 * consultar Git. El bloque no es un mensaje, así que no entra al store ni al rewind.
 */
interface ChangeEntry {
  path: string; staged: string; worktree: string; diff: string; truncated?: boolean;
  stagedAdded?: number | null; stagedRemoved?: number | null;
  worktreeAdded?: number | null; worktreeRemoved?: number | null;
}
interface ChangeResponse {
  kind: 'git' | 'not-git' | 'error';
  cwd?: string; root?: string; entries: ChangeEntry[]; truncated: boolean; error?: string;
}
declare global {
  interface Window {
    __aegisChanges?: {
      /** Vuelve a consultar Git y pinta el bloque al final del transcript. */
      refresh: () => Promise<void>;
      /** Lo saca del transcript (no consulta nada). */
      clear: () => void;
      /** true si el bloque está montado ahora mismo. */
      isOpen: () => boolean;
    };
  }
}

const ESTADO = 'git-changes';
let bloque: HTMLElement | null = null;
let serial = 0;
let sesionVista = '';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, texto?: string): HTMLElementTagNameMap[K] {
  const nodo = document.createElement(tag);
  if (texto !== undefined) nodo.textContent = texto;
  return nodo;
}

function estado() {
  const web = (window as Window & { __aegisWeb?: { state?: { current?: { id?: string; cwd?: string } } } }).__aegisWeb;
  return web?.state?.current || null;
}

function conteo(agregadas: unknown, quitadas: unknown): string {
  const n = (valor: unknown) => typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= 0 ? valor : null;
  const a = n(agregadas), r = n(quitadas);
  return a === null || r === null ? '+? / −?' : `+${a} / −${r}`;
}

// Git no registra si corrieron las pruebas ni quién escribió cada línea: el bloque lo dice en vez
// de insinuar cualquiera de las dos cosas.
const HONESTIDAD = 'Estado actual de Git · autor desconocido · Git no registra si corrieron las pruebas';

function montar(): HTMLElement | null {
  // #messages es el contenedor de scroll y existe desde el HTML; #msg-inner lo crea app.ts recién
  // al primer mensaje o al saludo, así que no sirve como ancla (un turno que no dejó mensajes
  // visibles se quedaba sin bloque).
  const inner = document.querySelector<HTMLElement>('#messages');
  if (!inner) return null;
  if (!bloque || !bloque.isConnected) {
    bloque = el('section');
    bloque.className = ESTADO;
    bloque.setAttribute('aria-label', 'Cambios Git del directorio de la sesión');
    inner.append(bloque);
  }
  // Siempre al final: es el estado del árbol ahora, no un mensaje del medio de la charla.
  else if (inner.lastElementChild !== bloque) inner.append(bloque);
  return bloque;
}

function cabecera(nodo: HTMLElement, titulo: string, sub: string): void {
  const head = el('header');
  const icono = el('span', '⎇'); icono.className = 'gc-ic'; icono.setAttribute('aria-hidden', 'true');
  const nombre = el('b', titulo);
  const detalle = el('span', sub); detalle.className = 'gc-sub';
  const recargar = el('button', '↻');
  recargar.type = 'button'; recargar.className = 'gc-btn'; recargar.title = 'Recargar cambios';
  recargar.setAttribute('aria-label', 'Recargar cambios');
  recargar.addEventListener('click', () => void refresh());
  const cerrar = el('button', '×');
  cerrar.type = 'button'; cerrar.className = 'gc-btn'; cerrar.title = 'Ocultar hasta el próximo turno';
  cerrar.setAttribute('aria-label', 'Ocultar los cambios');
  cerrar.addEventListener('click', () => clear());
  head.append(icono, nombre, detalle, recargar, cerrar);
  nodo.replaceChildren(head);
}

function pintar(carga: ChangeResponse, sesion: string): void {
  const nodo = montar();
  if (!nodo) return;
  nodo.dataset.estado = carga.kind === 'git' ? (carga.entries.length ? 'con-cambios' : 'sin-cambios') : carga.kind;
  nodo.dataset.sesion = sesion;
  const raiz = carga.root || carga.cwd || '';
  const n = carga.entries.length;
  cabecera(nodo, 'Cambios Git',
    carga.kind === 'git' ? `${n} ${n === 1 ? 'archivo' : 'archivos'}${raiz ? ' · ' + raiz : ''}` : '');

  const cuerpo = el('div'); cuerpo.className = 'gc-body';
  if (carga.kind === 'not-git') {
    cuerpo.append(el('p', 'El directorio de esta sesión no es un repositorio Git.'));
  } else if (!n) {
    cuerpo.append(el('p', 'Git no informa cambios locales.'));
  }
  for (const item of carga.entries.slice(0, 60)) {
    if (!item || typeof item.path !== 'string' || typeof item.diff !== 'string'
      || typeof item.staged !== 'string' || typeof item.worktree !== 'string') continue;
    const fila = el('details'); fila.className = 'gc-file';
    const resumen = el('summary');
    const ruta = el('code', item.path); ruta.className = 'gc-path';
    const marcas = el('span', `${item.staged}${item.worktree}`.trim() || '·'); marcas.className = 'gc-mark';
    const detalle = el('span', item.worktree === '?'
      ? 'sin seguimiento'
      : [item.staged !== ' ' ? 'staged ' + conteo(item.stagedAdded, item.stagedRemoved) : '',
        item.worktree !== ' ' ? 'sin stage ' + conteo(item.worktreeAdded, item.worktreeRemoved) : ''].filter(Boolean).join(' · '));
    detalle.className = 'gc-counts';
    resumen.append(marcas, ruta, detalle);
    fila.append(resumen);
    const pre = el('pre', item.diff || (item.worktree === '?' ? 'Archivo no rastreado; no se muestra contenido.' : 'Diff no disponible o sin contenido textual.'));
    fila.append(pre);
    if (item.truncated) { const t = el('p', 'Diff recortado.'); t.className = 'gc-note'; fila.append(t); }
    cuerpo.append(fila);
  }
  nodo.append(cuerpo);

  const pie = el('p', `${HONESTIDAD}${carga.truncated ? ' · resultado recortado' : ''}`);
  pie.className = 'gc-foot';
  nodo.append(pie);
}

function fallo(mensaje: string): void {
  const nodo = montar();
  if (!nodo) return;
  nodo.dataset.estado = 'error';
  cabecera(nodo, 'Cambios Git', '');
  const cuerpo = el('div'); cuerpo.className = 'gc-body';
  cuerpo.append(el('p', 'No se pudo leer Git: ' + mensaje));
  const pie = el('p', 'Sin backend validado no hay datos de Git. Nunca inferir ausencia de cambios.');
  pie.className = 'gc-foot';
  nodo.append(cuerpo, pie);
}

function valido(valor: unknown): valor is ChangeResponse {
  return !!valor && typeof valor === 'object' && ['git', 'not-git', 'error'].includes((valor as ChangeResponse).kind)
    && Array.isArray((valor as ChangeResponse).entries) && typeof (valor as ChangeResponse).truncated === 'boolean';
}

async function refresh(): Promise<void> {
  const actual = estado();
  if (!actual?.id) { clear(); return; }
  const mío = ++serial;
  const nodo = montar();
  if (!nodo) return;
  nodo.dataset.estado = 'cargando';
  sesionVista = actual.id;
  cabecera(nodo, 'Cambios Git', 'consultando…');
  const cuerpo = el('div'); cuerpo.className = 'gc-body';
  cuerpo.append(el('p', 'Consultando Git…'));
  nodo.append(cuerpo);
  try {
    const respuesta = await fetch('/changes.json?sessionId=' + encodeURIComponent(actual.id), { cache: 'no-store' });
    if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
    const datos: unknown = await respuesta.json();
    if (!valido(datos)) throw new Error('Respuesta inválida');
    const sigue = estado();
    if (mío !== serial || sigue?.id !== actual.id) return; // otra sesión o un refresh más nuevo
    if (datos.kind === 'error') throw new Error(datos.error || 'Consulta no disponible');
    pintar(datos, actual.id);
  } catch (error) {
    if (mío !== serial) return;
    fallo(error instanceof Error ? error.message : String(error));
  }
}

function clear(): void {
  serial++;
  bloque?.remove();
  bloque = null;
  sesionVista = '';
}

window.__aegisChanges = { refresh, clear, isOpen: () => !!bloque?.isConnected };
export {};
