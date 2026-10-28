import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from './harness';
import type { FixtureSession } from '../src/fixtures/server';
import type { SessionId } from '../src/domain/ids';

const session = (sessionId: string, title: string): FixtureSession => ({ sessionId, title, activeRunId: null, messages: [] });

let harness: Harness | null = null;
afterEach(() => {
  harness?.store.dispose();
  harness = null;
});

const boot = async (sessions: readonly FixtureSession[]): Promise<Harness> => {
  const h = createHarness(sessions);
  harness = h;
  await h.connect();
  await h.store.refreshSessions();
  await h.flush();
  return h;
};

// Comportamiento medido contra el motor real (2026-10-28, tools/acp-lifecycle.mjs):
// `_aegis/unstable/session/rename` responde ok pero `session/list` sigue devolviendo el título
// viejo, y archivar saca la sesión de la lista. El fixture imita al motor: rename no toca el list.
describe('ciclo de vida de sesiones contra el motor', () => {
  it('el título renombrado sobrevive al refresco de la lista', async () => {
    const h = await boot([session('r', 'Chat nuevo'), session('s', 'Otro')]);
    await h.store.renameSession('r' as SessionId, 'Nombre puesto a mano');
    await h.flush();
    expect(h.store.getState().sessionIndex['r']?.summary.title).toBe('Nombre puesto a mano');
    await h.store.refreshSessions();
    await h.flush();
    expect(h.store.getState().sessionIndex['r']?.summary.title).toBe('Nombre puesto a mano');
    expect(h.store.getState().sessionIndex['s']?.summary.title).toBe('Otro');
  });

  it('archivar saca la sesión de las vivas y desarchivar la devuelve sin duplicar', async () => {
    const h = await boot([session('a1', 'A'), session('a2', 'B')]);
    await h.store.archive('a1' as SessionId, true);
    await h.flush();
    let state = h.store.getState();
    expect(state.sessions.includes('a1' as SessionId)).toBe(false);
    expect(state.archived.includes('a1' as SessionId)).toBe(true);
    expect(state.sessions.length).toBe(1);

    await h.store.archive('a1' as SessionId, false);
    await h.flush();
    state = h.store.getState();
    expect(state.archived.includes('a1' as SessionId)).toBe(false);
    expect(state.sessions.filter((id) => id === ('a1' as SessionId)).length).toBe(1);
    expect(new Set(state.sessions).size).toBe(state.sessions.length);
  });

  it('exporta y avisa con el nombre y el tamaño', async () => {
    const h = await boot([session('x1', 'Chat exportable')]);
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:falso', revokeObjectURL: () => {} }));
    await h.store.exportSession('x1' as SessionId, 'markdown');
    await h.flush();
    const notices = h.store.getState().notices;
    expect(notices.some((notice) => notice.text.includes('Exportado Chat exportable.md'))).toBe(true);
    vi.unstubAllGlobals();
  });
});
