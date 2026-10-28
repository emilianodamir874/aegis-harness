import { useEffect, useMemo, useState } from 'react';
import type { AegisStore } from '../domain/store';
import type { AppState } from '../domain/types';
import type { SessionId } from '../domain/ids';
import { buildHandoff } from '../domain/handoff';
import { Dialog } from './Dialog';

export function HandoffDialog({
  open,
  onClose,
  state,
  store,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  state: AppState;
  store: AegisStore;
  onInsert: (text: string) => void;
}) {
  const candidates = useMemo(
    () =>
      state.sessions
        .filter((id) => id !== state.activeSessionId)
        .map((id) => state.sessionIndex[id]?.summary)
        .filter((summary): summary is NonNullable<typeof summary> => Boolean(summary)),
    [state.sessions, state.activeSessionId, state.sessionIndex],
  );
  const [source, setSource] = useState<string>('');
  const [block, setBlock] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!open) return;
    setBlock('');
    setStatus('');
    const first = candidates[0];
    setSource(first ? String(first.id) : '');
  }, [open, candidates]);

  useEffect(() => {
    if (!open || !source) return;
    let cancelled = false;
    setStatus('leyendo el transcript…');
    void store
      .exportText(source as SessionId, 'markdown')
      .then((text) => {
        if (cancelled) return;
        if (!text) {
          setStatus('el export vino vacío');
          return;
        }
        const title = state.sessionIndex[source]?.summary.title ?? source;
        setBlock(buildHandoff(title, text));
        setStatus(`${text.length} caracteres leídos · bloque listo para revisar`);
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatus(`no pude exportar: ${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [open, source, store, state.sessionIndex]);

  return (
    <Dialog open={open} title="Pasar contexto a esta sesión" onClose={onClose} wide>
      <div className="kv">
        <label className="kv-row">
          <span>Sesión origen</span>
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            {candidates.length === 0 ? <option value="">no hay otras sesiones</option> : null}
            {candidates.map((summary) => (
              <option key={String(summary.id)} value={String(summary.id)}>
                {summary.title} · {(summary.updatedAt ?? '').slice(0, 10)}
              </option>
            ))}
          </select>
        </label>
        <textarea
          className="ho-area"
          aria-label="Bloque de handoff"
          value={block}
          placeholder="Elegí una sesión origen para generar el bloque"
          onChange={(event) => setBlock(event.target.value)}
        />
      </div>
      <div className="row-actions">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(block).then(
              () => setStatus('copiado'),
              () => setStatus('el navegador no dejó copiar: seleccioná y Ctrl+C'),
            );
          }}
          disabled={!block.trim()}
        >
          Copiar
        </button>
        <button
          type="button"
          className="primary"
          disabled={!block.trim()}
          onClick={() => {
            onInsert(block);
            setStatus('insertado en el composer (todavía sin enviar)');
          }}
        >
          Insertar en el composer
        </button>
        <span className="muted">{status}</span>
      </div>
    </Dialog>
  );
}
