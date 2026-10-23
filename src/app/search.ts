// Resultados de busqueda en el contenido (endpoint /search.json del proxy).
//
// El filtro del sidebar sigue siendo local (titulos de las sesiones ya cargadas). Esto agrega
// una seccion aparte con las sesiones cuyos MENSAJES coinciden, con el fragmento donde
// aparece. Todo el texto viene del server: se escapa y las marcas del indice (\u0001 / \u0002)
// se convierten en <mark> DESPUES de escapar, asi que nunca se inyecta HTML ajeno.

import { esc, fmtTime } from './format';

export type Hit = { role: string; ts: number; snippet: string };
export type RemoteSession = {
  sessionId: string;
  title: string;
  cwd?: string;
  updatedAt?: string;
  archived?: boolean;
  titleMatch?: boolean;
  matches?: Hit[];
};
export type RemoteState = {
  q: string;
  loading: boolean;
  sessions: RemoteSession[];
  totalMatches: number;
  truncated: boolean;
  unavailable: boolean;
};

export const emptyRemote = (): RemoteState => ({
  q: '',
  loading: false,
  sessions: [],
  totalMatches: 0,
  truncated: false,
  unavailable: false,
});

const marks = (raw: unknown): string =>
  esc(String(raw == null ? '' : raw))
    .replace(/\u0001/g, '<mark>')
    .replace(/\u0002/g, '</mark>')
    // Fragmentos de contexto interno (turn-context) no aportan nada al ojo: se recortan.
    .replace(/&lt;\/?(turn-context|current-time|working-directory)[^&]*&gt;/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const folder = (p?: string): string => {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || '';
};

function hitRow(s: RemoteSession, active: boolean): string {
  const ms = (s.matches || []).slice(0, 2);
  const n = (s.matches || []).length;
  const badge = s.titleMatch && !n
    ? '<span class="sb-hit-badge" title="Coincide en el título">título</span>'
    : n
      ? `<span class="sb-hit-badge" title="${s.titleMatch ? 'También coincide el título' : n + ' coincidencias en los mensajes'}">${n}</span>`
      : '';
  const meta = [fmtTime(s.updatedAt || ''), folder(s.cwd)].filter(Boolean).join(' · ');
  const snippets = ms.map((m) => `<span class="sb-snip">${marks(m.snippet)}</span>`).join('');
  return (
    `<div class="sb-row sb-hit" data-id="${esc(s.sessionId)}">` +
    `<button class="sb-item${active ? ' active' : ''}" type="button" aria-label="${esc(s.title || 'Sesión')} — coincidencias en los mensajes">` +
    `<span class="sb-title"><span class="sb-name">${esc(s.title || 'Sesión')}</span>${s.archived ? '<span class="sb-tag">archivada</span>' : ''}${badge}</span>` +
    (meta ? `<span class="sb-sub">${esc(meta)}</span>` : '') +
    snippets +
    '</button></div>'
  );
}

export function remoteResultsHtml(st: RemoteState | null | undefined, activeId?: string | null, localIds?: Set<string>): string {
  if (!st || st.unavailable) return '';
  if (!st.loading && !st.sessions.length) return '';
  // Una sesión que ya está en la lista local y solo coincide por título es la misma fila dos
  // veces (la lista local ya la muestra). Con coincidencias en mensajes sí se muestra, porque
  // aporta los fragmentos, que la lista local no tiene.
  const rows = st.sessions.filter((s) => {
    const hasHits = (s.matches || []).length > 0;
    if (!hasHits && s.titleMatch && localIds && localIds.has(s.sessionId)) return false;
    return true;
  });
  if (!st.loading && !rows.length) return '';
  const head = st.loading && !rows.length
    ? '<div class="sb-group sb-remote-head">En los mensajes</div>'
    : '<div class="sb-group sb-remote-head">En los mensajes' +
      (rows.length ? `<span class="sb-count">${rows.length}</span>` : '') +
      (st.truncated ? '<span class="sb-trunc" title="Se muestran las primeras coincidencias; afiná la búsqueda">+</span>' : '') +
      '</div>';
  if (st.loading && !rows.length) {
    return head + '<div class="sb-remote-loading">Buscando en el contenido…</div>';
  }
  return head + rows.map((s) => hitRow(s, !!activeId && s.sessionId === activeId)).join('');
}
