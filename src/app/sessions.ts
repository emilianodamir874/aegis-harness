// Render de la lista de sesiones: funciones puras (estado -> HTML).
// Quien decide "corriendo" / "termino hace poco" es app.ts; aca solo se pinta.
//
// v4 (2026-10-22): una sola accion por fila (⋯). Antes cada fila mostraba tres
// iconos (renombrar / mas / borrar) que en tactil quedaban siempre visibles,
// tapaban el titulo y dejaban "borrar" a un toque de distancia. Las acciones
// viven en el menu de fila (app.ts -> openRowMenu), que incluye borrar con
// confirmacion.

import { esc, fmtTime, dayLabel } from './format';

export type SessionEntry = {
  sessionId: string;
  title?: string;
  updatedAt?: string;
  _meta?: { messageCount?: number; createdAt?: string } | null;
};

export type RowOpts = {
  archived: boolean;
  active?: boolean;
  running?: boolean;
  done?: boolean;
};

const KEBAB =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">' +
  '<circle cx="8" cy="3.2" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="12.8" r="1.4" fill="currentColor"/></svg>';

export function sessionRow(s: SessionEntry, o: RowOpts): string {
  const meta = s._meta || {};
  const n = meta.messageCount;
  const stamp = fmtTime(s.updatedAt || meta.createdAt);
  const bits: string[] = [];
  if (n != null) bits.push(n === 1 ? '1 mensaje' : n + ' mensajes');
  if (stamp) bits.push(stamp);
  const sub = bits.join(' · ');
  const title = s.title || 'Sesión';
  const active = o.active ? ' active' : '';
  const arch = o.archived;
  const dot = o.running
    ? '<span class="sb-dot sb-run-dot" title="En producción ahora" aria-hidden="true"></span>'
    : o.done
      ? '<span class="sb-dot sb-done-dot" title="Terminó hace un momento" aria-hidden="true"></span>'
      : '';
  const stateText = o.running ? ' — en producción' : o.done ? ' — terminó hace un momento' : '';
  const label = esc(title + (arch ? ' (archivada)' : '') + stateText + (sub ? ' — ' + sub : ''));
  return (
    `<div class="sb-row" data-id="${esc(s.sessionId)}"${arch ? ' data-arch="1"' : ''}>` +
    `<button class="sb-item${active}${arch ? ' arch' : ''}" type="button"` +
    `${o.active ? ' aria-current="true"' : ''} aria-label="${label}" title="${esc(title)}">` +
    `<span class="sb-title">${dot}<span class="sb-name">${esc(title)}</span>${arch ? '<span class="sb-tag">archivada</span>' : ''}</span>` +
    `<span class="sb-sub">${esc(sub)}</span>` +
    `</button>` +
    `<button class="sb-more" type="button" title="Acciones de la sesión" aria-label="Acciones de ${esc(title)}" aria-haspopup="menu" aria-expanded="false">${KEBAB}</button>` +
    `</div>`
  );
}

export type ListState = {
  sessions: SessionEntry[];
  archived: SessionEntry[];
  filter: string;
  cursor?: string | null;
  pages: number;
  showArchived: boolean;
  activeId?: string | null;
  isRunning: (id: string) => boolean;
  isDoneRecently: (id: string) => boolean;
  /** coincidencias en el contenido: van en su propia seccion, no cuentan como "sin resultados" */
  remoteCount?: number;
  /** hay una busqueda en el contenido en curso: tampoco corresponde decir "sin resultados" */
  remotePending?: boolean;
};

const updatedAt = (s: SessionEntry): string => s.updatedAt || (s._meta && s._meta.createdAt) || '';
const ts = (s: SessionEntry): number => Date.parse(updatedAt(s)) || 0;

// Normaliza para buscar: minusculas y sin acentos ("revision" encuentra "Revisión").
// Tambien se busca por id de sesion: es lo que aparece en los logs y en los reportes.
const norm = (v: string): string =>
  String(v == null ? '' : v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export function sessionListHtml(st: ListState): string {
  const q = norm(st.filter.trim());
  const match = (s: SessionEntry) => !q || norm(s.title).includes(q) || norm(s.sessionId).includes(q);
  // Orden por recencia en el cliente: el server a veces intercala por la clave de
  // paginación y quedaban grupos "Hoy/Ayer" desordenados.
  const items = st.sessions.filter(match).sort((a, b) => ts(b) - ts(a));
  const arch = st.archived.filter(match).sort((a, b) => ts(b) - ts(a));
  if (!items.length && !arch.length) {
    // Si hay coincidencias en el contenido, la seccion remota habla por si sola: un
    // "sin resultados" arriba de resultados reales se contradice.
    if (st.remoteCount || st.remotePending) return '';
    return `<div class="sb-empty">${st.sessions.length || st.archived.length ? 'Sin resultados para «' + esc(st.filter.trim()) + '»' : 'Sin sesiones todavía'}</div>`;
  }
  const row = (s: SessionEntry, archived: boolean) =>
    sessionRow(s, {
      archived,
      active: st.activeId === s.sessionId,
      running: st.isRunning(s.sessionId),
      done: !st.isRunning(s.sessionId) && st.isDoneRecently(s.sessionId),
    });
  let html = '';
  let lastGroup: string | null = null;
  for (const s of items) {
    const group = dayLabel(updatedAt(s));
    if (group !== lastGroup) { html += `<div class="sb-group" role="presentation">${group}</div>`; lastGroup = group; }
    html += row(s, false);
  }
  if (st.cursor) {
    const more = st.pages > 1 ? `Cargar más (${st.pages} páginas)` : 'Cargar más sesiones';
    html += `<button class="sb-more-btn" type="button">${more}</button>`;
  }
  if (arch.length || st.archived.length) {
    if (st.showArchived) {
      html += `<div class="sb-group" role="presentation">Archivadas</div>`;
      html += arch.length ? arch.map((s) => row(s, true)).join('') : `<div class="sb-empty">Ninguna coincide con la búsqueda.</div>`;
      html += `<button class="sb-arch-toggle open" type="button"><span class="caret">▸</span> Ocultar archivadas</button>`;
    } else {
      html += `<button class="sb-arch-toggle" type="button"><span class="caret">▸</span> Ver archivadas (${st.archived.length})</button>`;
    }
  }
  return html;
}
