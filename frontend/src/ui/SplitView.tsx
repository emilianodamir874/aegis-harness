import { useEffect, useMemo, useState } from 'react';
import type { AegisStore } from '../domain/store';
import type { AppState } from '../domain/types';
import type { SessionId } from '../domain/ids';
import { renderMarkdown } from '../render/markdown';

/**
 * Split view: una segunda sesión al costado, en modo lectura.
 *
 * Igual criterio que el cliente actual (`web/src/split-view.ts`): es una *foto* tomada con
 * `session/export`, no un espejo en vivo, y se refresca cuando el operador lo pide. Un segundo
 * stream en vivo necesitaría otra conexión ACP y un segundo juego de cursores; una foto honesta con
 * su botón es preferible a un panel que se desincroniza sin avisar.
 */
export function SplitView({
  open,
  onClose,
  state,
  store,
}: {
  open: boolean;
  onClose: () => void;
  state: AppState;
  store: AegisStore;
}) {
  const others = useMemo(
    () =>
      state.sessions
        .filter((id) => id !== state.activeSessionId)
        .map((id) => state.sessionIndex[id]?.summary)
        .filter((summary): summary is NonNullable<typeof summary> => Boolean(summary)),
    [state.sessions, state.activeSessionId, state.sessionIndex],
  );
  const [source, setSource] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!open) return;
    const first = others[0];
    setSource(first ? String(first.id) : '');
    setText('');
    setStatus(first ? 'foto en solo lectura · Ctrl+Alt+2 para cerrar' : 'sin sesiones para comparar');
  }, [open, others]);

  const load = (id: string): void => {
    if (!id) return;
    setStatus('leyendo…');
    void store.exportText(id as SessionId, 'markdown').then(
      (markdown) => {
        setText(markdown);
        setStatus(
          markdown
            ? `${markdown.length} caracteres · foto del ${new Date().toLocaleTimeString()}`
            : 'el export vino vacío',
        );
      },
      (error: unknown) => setStatus(`no pude leer: ${error instanceof Error ? error.message : String(error)}`),
    );
  };

  useEffect(() => {
    if (!open || !source) return;
    load(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sólo al abrir o cambiar de sesión
  }, [open, source]);

  if (!open) return null;
  const html = text ? renderMarkdown(text) : '';

  return (
    <aside className="split-pane" role="complementary" aria-label="Segunda sesión (solo lectura)">
      <header>
        <select aria-label="Sesión de la segunda columna" value={source} onChange={(event) => setSource(event.target.value)}>
          {others.length === 0 ? <option value="">no hay otras sesiones</option> : null}
          {others.map((summary) => (
            <option key={String(summary.id)} value={String(summary.id)}>
              {summary.title} · {(summary.updatedAt ?? '').slice(0, 10)}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => load(source)} disabled={!source}>
          Refrescar
        </button>
        <button type="button" onClick={onClose}>
          Cerrar
        </button>
      </header>
      <div className="split-body">
        {html ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="muted">{text ? 'Sin contenido.' : 'Elegí una sesión.'}</p>}
      </div>
      <div className="split-status">{status}</div>
    </aside>
  );
}
