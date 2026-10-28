import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from '../src/ui/Composer';
import { createHarness, type Harness } from './harness';
import type { SessionId } from '../src/domain/ids';
import type { SessionState } from '../src/domain/types';

let harness: Harness | null = null;
afterEach(() => {
  harness?.store.dispose();
  harness = null;
});

const boot = async (): Promise<{ store: Harness['store']; session: SessionState }> => {
  const h = createHarness([{ sessionId: 'c1', title: 'Chat', activeRunId: null, messages: [] }]);
  harness = h;
  await h.connect();
  await h.store.openSession('c1' as SessionId);
  await h.flush();
  const session = h.store.getState().sessionIndex['c1'];
  if (!session) throw new Error('sin sesión');
  return { store: h.store, session };
};

const dropDe = (nombre: string, contenido: string) => {
  const file = new File([contenido], nombre, { type: 'text/plain' });
  // jsdom no siempre implementa Blob.text(): el flujo del drop es lo que se prueba acá.
  Object.defineProperty(file, 'text', { value: async () => contenido, configurable: true });
  return { dataTransfer: { types: ['Files'], files: [file], items: [], getData: () => '' } };
};

describe('arrastrar archivos al compositor', () => {
  it('un drop agrega el adjunto', async () => {
    const { store, session } = await boot();
    render(<Composer store={store} session={session} onNotice={() => {}} />);
    const wrap = document.querySelector('.composer-wrap');
    if (!wrap) throw new Error('sin composer-wrap');
    fireEvent.dragOver(wrap, dropDe('nota.txt', 'hola'));
    await waitFor(() => expect(wrap.className).toContain('dragging'));
    fireEvent.drop(wrap, dropDe('nota.txt', 'hola'));
    await waitFor(() => expect(screen.getByText(/nota\.txt/)).toBeTruthy());
    expect(wrap.className).not.toContain('dragging');
  });

  it('un drop sin archivos no hace nada', async () => {
    const { store, session } = await boot();
    render(<Composer store={store} session={session} onNotice={() => {}} />);
    const wrap = document.querySelector('.composer-wrap');
    if (!wrap) throw new Error('sin composer-wrap');
    fireEvent.drop(wrap, { dataTransfer: { types: [], files: [], items: [], getData: () => '' } });
    expect(screen.queryByText(/nota\.txt/)).toBeNull();
  });
});
