import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState, useConfig, useStore } from './state/context';
import type { AppState, SessionState } from './domain/types';
import type { SessionId } from './domain/ids';
import { Sidebar } from './ui/Sidebar';
import { Topbar } from './ui/Topbar';
import { Transcript } from './ui/Transcript';
import { Composer } from './ui/Composer';
import { PermissionCard } from './ui/PermissionCard';
import { Palette, panelCommand, type Command } from './ui/Palette';
import { Dialog } from './ui/Dialog';
import { WorkspacePanel, type PanelId } from './ui/panels';

function ToastStack({ state, onDismiss }: { state: AppState; onDismiss: (id: string) => void }) {
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {state.notices.slice(-4).map((notice) => (
        <div key={notice.id} className={`toast toast-${notice.level}`} role={notice.level === 'error' ? 'alert' : 'status'}>
          <span>{notice.text}</span>
          <button type="button" className="icon-btn" aria-label="Descartar aviso" onClick={() => onDismiss(notice.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function RunBar({ session, onCancel }: { session: SessionState; onCancel: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const started = session.run?.startedAt ?? 0;
  useEffect(() => {
    if (!session.run) return;
    const timer = setInterval(() => setElapsed(Date.now() - started), 500);
    return () => clearInterval(timer);
  }, [session.run, started]);
  if (!session.run || session.run.endedAt !== null) return null;
  const seconds = Math.max(0, elapsed) / 1000;
  return (
    <div className="runbar" role="status">
      <span className="runbar-dot" aria-hidden="true" />
      <span className="runbar-text">
        {session.run.adopted ? 'Turno en curso (lo arrancó otra conexión)' : 'Trabajando'}
        {session.statusText ? ` · ${session.statusText}` : ''}
      </span>
      <span className="runbar-time">{seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`}</span>
      {session.speed ? <span className="runbar-tps">{session.speed.toFixed(0)} tok/s</span> : null}
      <button type="button" className="xbtn" onClick={onCancel}>
        Detener
      </button>
    </div>
  );
}

function ChatInfoDialog({
  open,
  onClose,
  session,
  store,
}: {
  open: boolean;
  onClose: () => void;
  session: SessionState | null;
  store: ReturnType<typeof useStore>;
}) {
  const [info, setInfo] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!open || !session) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    void store.sessionInfo(session.summary.id).then((remote) => {
      if (cancelled || !remote) return;
      setInfo({
        ...(remote._meta?.messageCount !== undefined ? { mensajes: String(remote._meta.messageCount) } : {}),
        ...(remote._meta?.watcherCount !== undefined ? { observadores: String(remote._meta.watcherCount) } : {}),
        ...(remote._meta?.activeRunId ? { run: remote._meta.activeRunId } : {}),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, session, store]);

  if (!session) return null;

  const exportMarkdown = async (): Promise<void> => {
    const response = await store.request<{ data?: string }>('_aegis/unstable/session/export', {
      sessionId: session.summary.id,
      format: 'markdown',
    });
    if (!response?.data) return;
    const blob = new Blob([response.data], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${session.summary.title.replace(/[^\w.-]+/g, '-') || 'sesion'}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} title="Información del chat" onClose={onClose}>
      <div className="kv">
        <div className="kv-row">
          <span>id</span>
          <span className="mono">{session.summary.id}</span>
        </div>
        {session.summary.cwd ? (
          <div className="kv-row">
            <span>carpeta</span>
            <span className="mono">{session.summary.cwd}</span>
          </div>
        ) : null}
        <div className="kv-row">
          <span>mensajes</span>
          <span>{session.summary.messageCount ?? '—'}</span>
        </div>
        <div className="kv-row">
          <span>actualizada</span>
          <span>{session.summary.updatedAt ?? '—'}</span>
        </div>
        <div className="kv-row">
          <span>historial</span>
          <span>
            {session.fullHistory ? 'completo' : session.replaySkipped > 0 ? `${session.replaySkipped} omitidos` : 'cola'}
          </span>
        </div>
        {info
          ? Object.entries(info).map(([key, value]) => (
              <div className="kv-row" key={key}>
                <span>{key}</span>
                <span className="mono">{String(value)}</span>
              </div>
            ))
          : null}
      </div>
      <div className="dlg-actions">
        <button type="button" className="xbtn" onClick={() => void navigator.clipboard.writeText(session.summary.id)}>
          Copiar ID
        </button>
        {session.summary.cwd ? (
          <button type="button" className="xbtn" onClick={() => void navigator.clipboard.writeText(session.summary.cwd ?? '')}>
            Copiar ruta
          </button>
        ) : null}
        <button type="button" className="xbtn" onClick={() => void exportMarkdown()}>
          Exportar Markdown
        </button>
      </div>
    </Dialog>
  );
}

export function App() {
  const store = useStore();
  const config = useConfig();
  const state = useAppState();
  const booted = useRef(false);
  const [drawer, setDrawer] = useState(false);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [palette, setPalette] = useState(false);
  const [chatInfo, setChatInfo] = useState(false);
  const [rename, setRename] = useState<{ id: SessionId; title: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: SessionId; title: string } | null>(null);

  const session = state.activeSessionId ? state.sessionIndex[state.activeSessionId] ?? null : null;
  const permissions = session ? store.permissionsOf(session.summary.id) : [];

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      try {
        await store.connect();
      } catch {
        return;
      }
      const sessions = await store.refreshSessions();
      const first = sessions[0];
      if (first) await store.openSession(first.id);
      else await store.newSession();
    })();
  }, [store]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;
      if (event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void store.newSession();
      } else if (event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setPalette(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: 'new', title: 'Nuevo chat', hint: 'Ctrl+Shift+O', run: () => void store.newSession() },
      { id: 'reload', title: 'Recargar historial de la sesión', run: () => void store.loadFullHistory() },
      { id: 'retry', title: 'Regenerar la última respuesta', run: () => void store.retry() },
      { id: 'cancel', title: 'Detener el turno en curso', run: () => void store.cancel() },
      { id: 'info', title: 'Información del chat', run: () => setChatInfo(true) },
      panelCommand('actividad', 'Actividad de sesiones', setPanel),
      panelCommand('cambios', 'Cambios Git', setPanel),
      panelCommand('archivos', 'Archivos del outbox', setPanel),
      panelCommand('memoria', 'Memoria del operador', setPanel),
      panelCommand('skills', 'Skills', setPanel),
      panelCommand('contexto', 'Contexto y costo', setPanel),
      panelCommand('doctor', 'Doctor', setPanel),
      panelCommand('stats', 'Estadísticas', setPanel),
      panelCommand('goals', 'Objetivos', setPanel),
      panelCommand('ajustes', 'Ajustes', setPanel),
    ];
    return list;
  }, [store]);

  return (
    <div className={`app${drawer ? ' drawer-open' : ''}`}>
      <a className="skip-link" href="#input">
        Saltar al compositor
      </a>
      <Sidebar
        state={state}
        store={store}
        open={drawer}
        onClose={() => setDrawer(false)}
        onOpenPanel={(id) => {
          setPanel(id);
          setDrawer(false);
        }}
        onRename={(id, title) => setRename({ id, title })}
        onDelete={(id, title) => setDeleting({ id, title })}
      />
      <div className="overlay" hidden={!drawer} onClick={() => setDrawer(false)} />
      <main className="main">
        <Topbar
          store={store}
          session={session}
          onMenu={() => setDrawer(true)}
          onInfo={() => setChatInfo(true)}
          onPalette={() => setPalette(true)}
        />
        {session ? <RunBar session={session} onCancel={() => void store.cancel()} /> : null}
        <div className="scroll">
          {session ? (
            <Transcript
              session={session}
              onRewind={(mid) => {
                void store.rewindTo(mid);
              }}
              onRetry={() => void store.retry()}
              onLoadFull={() => void store.loadFullHistory()}
            />
          ) : (
            <div className="transcript empty">
              <div className="welcome">
                <h1>Aegis</h1>
                <p>
                  {state.connection === 'ready'
                    ? 'Elegí un chat de la izquierda o creá uno nuevo.'
                    : 'Conectando con el motor ACP…'}
                </p>
                {config.defaultModel ? (
                  <p className="muted">
                    modelo por defecto: {config.defaultProvider ? `${config.defaultProvider} / ` : ''}
                    {config.defaultModel}
                  </p>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {permissions.map((request) => (
          <PermissionCard key={request.id} request={request} onRespond={(optionId) => void store.respondPermission(request.id, optionId)} />
        ))}

        {state.queue.length > 0 ? (
          <ul className="queue" aria-label="Cola de mensajes">
            {state.queue.map((item) => (
              <li key={item.id}>
                <span className={`q-state q-${item.state}`} aria-hidden="true" />
                <span className="q-text">{item.text || `${item.attachments.length} adjunto(s)`}</span>
                <button type="button" className="xbtn" onClick={() => store.dispatch({ type: 'queue/remove', id: item.id })}>
                  Quitar
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {session ? (
          <Composer
            store={store}
            session={session}
            onNotice={(level, text) => store.dispatch({ type: 'notice/push', level, text })}
          />
        ) : null}
      </main>

      <ToastStack state={state} onDismiss={(id) => store.dismissNotice(id)} />
      <Palette open={palette} onClose={() => setPalette(false)} commands={commands} />
      <WorkspacePanel panel={panel} onClose={() => setPanel(null)} state={state} session={session} store={store} />
      <ChatInfoDialog open={chatInfo} onClose={() => setChatInfo(false)} session={session} store={store} />

      <Dialog open={rename !== null} title="Renombrar chat" onClose={() => setRename(null)}>
        {rename ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const title = String(data.get('title') ?? '');
              if (title.trim()) {
                void store.renameSession(rename.id, title.trim());
                setRename(null);
              }
            }}
          >
            <input name="title" defaultValue={rename.title} autoFocus aria-label="Título del chat" className="text-input" />
            <div className="dlg-actions">
              <button type="button" className="xbtn" onClick={() => setRename(null)}>
                Cancelar
              </button>
              <button type="submit" className="send">
                Guardar
              </button>
            </div>
          </form>
        ) : null}
      </Dialog>

      <Dialog open={deleting !== null} title="Borrar chat" onClose={() => setDeleting(null)}>
        {deleting ? (
          <>
            <p>
              Se borra «{deleting.title}» y su historial del store. No se puede deshacer; archivar es la alternativa
              reversible.
            </p>
            <div className="dlg-actions">
              <button type="button" className="xbtn" onClick={() => setDeleting(null)}>
                Cancelar
              </button>
              <button
                type="button"
                className="send danger"
                onClick={() => {
                  void store.removeSession(deleting.id);
                  setDeleting(null);
                }}
              >
                Borrar
              </button>
            </div>
          </>
        ) : null}
      </Dialog>
    </div>
  );
}
