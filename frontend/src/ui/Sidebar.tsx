import { useEffect, useMemo, useRef, useState } from 'react';
import type { AegisStore } from '../domain/store';
import type { AppState } from '../domain/types';
import type { SessionId } from '../domain/ids';
import { isRunning } from '../domain/selectors';
import { SearchResults } from './SearchResults';

const norm = (value: string): string =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const dayLabel = (iso: string | null): string => {
  if (!iso) return 'Sin fecha';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const that = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start - that) / 86_400_000);
  if (days <= 0) return 'Hoy';
  if (days === 1) return 'Ayer';
  if (days < 7) return 'Esta semana';
  return 'Anteriores';
};

const fmtTime = (iso: string | null): string => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
};

interface RowMenuState {
  readonly id: SessionId;
  readonly top: number;
  readonly left: number;
}

export function Sidebar({
  state,
  store,
  open,
  onClose,
  onOpenPanel,
  onRename,
  onDelete,
}: {
  state: AppState;
  store: AegisStore;
  open: boolean;
  onClose: () => void;
  onOpenPanel: (panel: 'actividad' | 'cambios' | 'archivos' | 'memoria' | 'skills') => void;
  onRename: (id: SessionId, title: string) => void;
  onDelete: (id: SessionId, title: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const search = useRef<HTMLInputElement | null>(null);

  const sessions = useMemo(() => {
    const q = norm(filter.trim());
    const match = (id: SessionId): boolean => {
      const session = state.sessionIndex[id];
      if (!session) return false;
      return !q || norm(session.summary.title).includes(q) || norm(id).includes(q);
    };
    const sorted = (ids: readonly SessionId[]): SessionId[] =>
      ids
        .filter(match)
        .map((id) => ({ id, at: Date.parse(state.sessionIndex[id]?.summary.updatedAt ?? '') || 0 }))
        .sort((a, b) => b.at - a.at)
        .map((entry) => entry.id);
    return { live: sorted(state.sessions), archived: sorted(state.archived) };
  }, [filter, state.sessionIndex, state.sessions, state.archived]);

  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        search.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const rows = (ids: readonly SessionId[], archived: boolean) => {
    let lastGroup = '';
    const out = [];
    for (const id of ids) {
      const session = state.sessionIndex[id];
      if (!session) continue;
      const group = dayLabel(session.summary.updatedAt);
      if (group !== lastGroup) {
        out.push(
          <div className="sb-group" role="presentation" key={`g:${group}:${id}`}>
            {group}
          </div>,
        );
        lastGroup = group;
      }
      const running = isRunning(session);
      const active = state.activeSessionId === id;
      out.push(
        <div className="sb-row" key={id} data-id={id}>
          <button
            type="button"
            className={`sb-item${active ? ' active' : ''}${archived ? ' arch' : ''}`}
            aria-current={active ? 'true' : undefined}
            onClick={() => {
              void store.openSession(id);
              onClose();
            }}
            title={session.summary.title}
          >
            <span className="sb-title">
              {running ? <span className="sb-dot sb-run-dot" aria-label="en producción" /> : null}
              <span className="sb-name">{session.summary.title}</span>
              {archived ? <span className="sb-tag">archivada</span> : null}
            </span>
            <span className="sb-sub">
              {session.summary.messageCount !== null ? `${session.summary.messageCount} mensajes` : ''}
              {session.summary.messageCount !== null && session.summary.updatedAt ? ' · ' : ''}
              {fmtTime(session.summary.updatedAt)}
            </span>
          </button>
          <button
            type="button"
            className="sb-more"
            aria-label={`Acciones de ${session.summary.title}`}
            aria-haspopup="menu"
            aria-expanded={menu?.id === id}
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu(menu?.id === id ? null : { id, top: rect.bottom + 4, left: Math.max(8, rect.right - 180) });
            }}
          >
            ⋯
          </button>
          {menu !== null && menu.id === id ? (
            <div
              className="row-menu"
              role="menu"
              style={{ top: menu.top, left: menu.left }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button type="button" role="menuitem" onClick={() => onRename(id, session.summary.title)}>
                Renombrar
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void store.archive(id, !archived);
                  setMenu(null);
                }}
              >
                {archived ? 'Desarchivar' : 'Archivar'}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  void store.exportSession(id, 'markdown');
                }}
              >
                Exportar .md
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  void store.exportSession(id, 'json');
                }}
              >
                Exportar .json
              </button>
              <button type="button" role="menuitem" className="danger" onClick={() => onDelete(id, session.summary.title)}>
                Borrar
              </button>
            </div>
          ) : null}
        </div>,
      );
    }
    return out;
  };

  const pending = Object.values(state.pendingBySession).reduce((sum, n) => sum + n, 0);

  return (
    <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Sesiones">
      <div className="sb-head">
        <div className="brand">
          <span className="brand-aegis">
            <svg className="brand-mark" viewBox="0 0 128 128" width="17" height="17" aria-hidden="true">
              <circle cx="64" cy="66" r="36" fill="none" stroke="currentColor" strokeWidth="13" strokeDasharray="196 30" strokeLinecap="round" transform="rotate(-110 64 66)" />
              <circle cx="46" cy="34" r="13" fill="currentColor" />
            </svg>
          </span>
          <span className="brand-name">Aegis</span>
          <span className="brand-chip">react</span>
          <button type="button" className="icon-btn sb-close" aria-label="Cerrar menú" onClick={onClose}>
            ×
          </button>
        </div>
        <button type="button" className="btn-new" onClick={() => void store.newSession()} title="Nuevo chat (Ctrl+Shift+O)">
          <span aria-hidden="true">+</span> Nuevo chat
        </button>
        <div className="sb-search">
          <input
            ref={search}
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Buscar sesiones…"
            aria-label="Buscar sesiones por título o id"
            spellCheck={false}
          />
          <span className="kbd-hint">Ctrl K</span>
        </div>
      </div>

      <div className="sb-list" role="list" aria-label="Sesiones">
        {sessions.live.length === 0 && sessions.archived.length === 0 ? (
          <div className="sb-empty">Sin sesiones todavía</div>
        ) : null}
        {rows(sessions.live, false)}
        {filter.trim().length > 1 ? (
          <SearchResults
            query={filter}
            localIds={new Set<string>([...sessions.live, ...sessions.archived])}
            store={store}
            onNavigate={onClose}
          />
        ) : null}
        {state.archived.length > 0 ? (
          showArchived ? (
            <>
              <div className="sb-group" role="presentation">
                Archivadas
              </div>
              {rows(sessions.archived, true)}
              <button type="button" className="sb-arch-toggle open" onClick={() => setShowArchived(false)}>
                Ocultar archivadas
              </button>
            </>
          ) : (
            <button type="button" className="sb-arch-toggle" onClick={() => setShowArchived(true)}>
              Ver archivadas ({state.archived.length})
            </button>
          )
        ) : null}
      </div>

      <nav className="sb-tools" aria-label="Espacio de trabajo">
        <button type="button" className="sb-tool" onClick={() => onOpenPanel('actividad')}>
          Actividad
        </button>
        <button type="button" className="sb-tool" onClick={() => onOpenPanel('cambios')}>
          Cambios
        </button>
        <button type="button" className="sb-tool" onClick={() => onOpenPanel('archivos')}>
          Archivos
        </button>
        <button type="button" className="sb-tool" onClick={() => onOpenPanel('memoria')}>
          Memoria
        </button>
        <button type="button" className="sb-tool" onClick={() => onOpenPanel('skills')}>
          Skills
        </button>
      </nav>

      <div className="sb-foot">
        <span className={`dot dot-${state.connection}`} aria-hidden="true" />
        <span id="conn-text">
          {state.connection === 'ready'
            ? 'Conectado'
            : state.connection === 'connecting'
              ? 'Conectando…'
              : state.connection === 'reconnecting'
                ? `Reconectando${state.retryIn ? ` (${Math.round(state.retryIn / 1000)} s)` : ''}`
                : 'Sin conexión'}
        </span>
        {pending > 0 ? <span className="sb-pending">{pending} confirmación(es)</span> : null}
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {state.connection === 'ready' ? 'Conectado' : ''}
      </div>
    </aside>
  );
}
