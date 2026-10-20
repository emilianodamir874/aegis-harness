// Render de la lista de sesiones: funciones puras (estado -> HTML).
// Quien decide "corriendo" / "termino hace poco" es app.ts; aca solo se pinta.

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

export function sessionRow(s: SessionEntry, o: RowOpts): string {
  const meta = s._meta || {};
  const n = meta.messageCount;
  const sub = `${n != null ? n + ' · ' : ''}${fmtTime(s.updatedAt || meta.createdAt)}`;
  const active = o.active ? ' active' : '';
  const arch = o.archived;
  return (
    `<div class="sb-row" data-id="${esc(s.sessionId)}"${arch ? ' data-arch="1"' : ''}>` +
    `<button class="sb-item${active}${arch ? ' arch' : ''}"><div class="sb-title">${o.running ? '<span class="sb-run-dot" title="en produccion ahora">&#9679;</span>' : ''}${o.done ? '<span class="sb-done-dot" title="termino hace un momento">&#10004;</span>' : ''}${esc(s.title || 'Sesión')}${arch ? '<span class="sb-tag">archivada</span>' : ''}</div><div class="sb-sub">${sub}</div></button>` +
    `<button class="sb-rename" title="Renombrar" aria-label="Renombrar">✎</button>` +
    `<button class="sb-more" title="Más acciones" aria-label="Más acciones">⋮</button>` +
    `<button class="sb-del" title="Borrar sesión" aria-label="Borrar sesión">✕</button>` +
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
};

const updatedAt = (s: SessionEntry): string => s.updatedAt || (s._meta && s._meta.createdAt) || '';
const ts = (s: SessionEntry): number => Date.parse(updatedAt(s)) || 0;

export function sessionListHtml(st: ListState): string {
  const q = st.filter.trim().toLowerCase();
  const match = (s: SessionEntry) => !q || String(s.title || '').toLowerCase().includes(q);
  // Orden por recencia en el cliente: el server a veces intercala por la clave de
  // paginación y quedaban grupos "Hoy/Ayer" desordenados.
  const items = st.sessions.filter(match).sort((a, b) => ts(b) - ts(a));
  const arch = st.archived.filter(match).sort((a, b) => ts(b) - ts(a));
  if (!items.length && !arch.length) {
    return `<div class="sb-empty">${st.sessions.length || st.archived.length ? 'Sin resultados' : 'Sin sesiones todavía'}</div>`;
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
    if (group !== lastGroup) { html += `<div class="sb-group">${group}</div>`; lastGroup = group; }
    html += row(s, false);
  }
  if (st.cursor) {
    const more = st.pages > 1 ? `Cargar más (${st.pages} páginas)` : 'Cargar más sesiones';
    html += `<button class="sb-more-btn" type="button">${more}</button>`;
  }
  if (arch.length || st.archived.length) {
    if (st.showArchived) {
      html += `<div class="sb-group">Archivadas</div>`;
      html += arch.length ? arch.map((s) => row(s, true)).join('') : `<div class="sb-empty">Ninguna coincide con la búsqueda.</div>`;
      html += `<button class="sb-arch-toggle open" type="button"><span class="caret">▶</span> Ocultar archivadas</button>`;
    } else {
      html += `<button class="sb-arch-toggle" type="button"><span class="caret">▶</span> Ver archivadas (${st.archived.length})</button>`;
    }
  }
  return html;
}
