import type { AegisStore } from '../domain/store';
import type { SessionState } from '../domain/types';

export function Topbar({
  store,
  session,
  onMenu,
  onInfo,
  onPalette,
}: {
  store: AegisStore;
  session: SessionState | null;
  onMenu: () => void;
  onInfo: () => void;
  onPalette: () => void;
}) {
  const mode = session?.modes.find((m) => m.id === session.currentModeId) ?? null;
  const effort = session?.configOptions.find((option) => option.id === 'thinking_effort') ?? null;
  return (
    <header className="topbar">
      <button type="button" className="icon-btn only-mobile" aria-label="Abrir menú de sesiones" onClick={onMenu}>
        ≡
      </button>
      <div className="topbar-title">
        <h1 title={session?.summary.title ?? ''}>{session?.summary.title ?? 'Aegis'}</h1>
        {session?.summary.cwd ? <span className="topbar-path">{session.summary.cwd}</span> : null}
      </div>
      <div className="topbar-chips">
        {mode ? (
          <label className="chip-select">
            <span className="sr-only">Modo</span>
            <select
              value={session?.currentModeId ?? ''}
              onChange={(event) => void store.setMode(event.target.value)}
              aria-label="Modo de la sesión"
            >
              {session?.modes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {effort ? (
          <label className="chip-select">
            <span className="sr-only">Esfuerzo de razonamiento</span>
            <select
              value={effort.currentValue ?? ''}
              onChange={(event) => void store.setConfigOption(effort.id, event.target.value)}
              aria-label="Esfuerzo de razonamiento"
            >
              {(effort.options ?? [{ value: effort.currentValue ?? '', name: effort.currentValue ?? '—' }]).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button type="button" className="icon-btn" onClick={onPalette} title="Paleta de comandos (Ctrl+K con /)" aria-label="Paleta de comandos">
          ⌘
        </button>
        <button type="button" className="icon-btn" onClick={onInfo} title="Información del chat" aria-label="Información del chat">
          i
        </button>
        <span className={`dot dot-${session?.run ? 'ready' : 'idle'}`} title={session?.run ? 'Turno en curso' : 'Sin turno'} />
      </div>
    </header>
  );
}
