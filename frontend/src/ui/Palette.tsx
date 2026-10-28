import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import type { PanelId } from './panels';

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly hint?: string;
  readonly run: () => void;
}

const norm = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/** Paleta de comandos: filtra por título, flechas mueven, Enter ejecuta, Escape cierra. */
export function Palette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: readonly Command[];
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return commands;
    return commands.filter((command) => norm(command.title).includes(q) || norm(command.hint ?? '').includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
  }, [open]);

  useEffect(() => {
    setIndex((current) => (current >= filtered.length ? Math.max(0, filtered.length - 1) : current));
  }, [filtered.length]);

  useEffect(() => {
    const node = list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const execute = (command: Command | undefined): void => {
    if (!command) return;
    onClose();
    command.run();
  };

  return (
    <Dialog open={open} title="Paleta de comandos" onClose={onClose}>
      <input
        className="palette-input"
        autoFocus
        value={query}
        placeholder="Buscar un comando…"
        aria-label="Buscar comando"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setIndex((current) => Math.min(filtered.length - 1, current + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setIndex((current) => Math.max(0, current - 1));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            execute(filtered[index]);
          }
        }}
      />
      <div className="palette-list" ref={list} role="listbox" aria-label="Comandos">
        {filtered.length === 0 ? <p className="muted">Sin coincidencias.</p> : null}
        {filtered.map((command, i) => (
          <button
            type="button"
            key={command.id}
            role="option"
            aria-selected={i === index}
            data-index={i}
            className={`palette-item${i === index ? ' active' : ''}`}
            onMouseEnter={() => setIndex(i)}
            onClick={() => execute(command)}
          >
            <span>{command.title}</span>
            {command.hint ? <span className="palette-hint">{command.hint}</span> : null}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

export const panelCommand = (id: PanelId, title: string, open: (panel: PanelId) => void): Command => ({
  id: `panel:${id}`,
  title,
  run: () => open(id),
});
