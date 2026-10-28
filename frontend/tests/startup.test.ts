import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';
import type { SessionId } from '../src/domain/ids';

let harness: Harness | null = null;
afterEach(() => {
  harness?.store.dispose();
  harness = null;
});

const dosSesiones = [
  { sessionId: 'reciente', title: 'Reciente', activeRunId: null, messages: [{ role: 'user' as const, text: 'hola', messageId: 'm1' }] },
  { sessionId: 'vieja', title: 'Vieja', activeRunId: null, messages: [{ role: 'user' as const, text: 'chau', messageId: 'm2' }] },
];

describe('arranque del cliente', () => {
  it('abre el chat más reciente al conectar', async () => {
    const h = createHarness(dosSesiones);
    harness = h;
    await h.connect();
    await h.flush();
    const state = h.store.getState();
    expect(state.activeSessionId).toBe('reciente');
    expect(state.sessionIndex['reciente']?.messages.length).toBe(1);
  });

  it('no cambia la pantalla si el operador ya eligió un chat', async () => {
    const h = createHarness(dosSesiones);
    harness = h;
    await h.connect();
    await h.flush();
    await h.store.openSession('vieja' as SessionId);
    await h.flush();
    // Un segundo aviso de "listo" (reconexión) no debe devolver la vista al más reciente.
    await h.sockets[0]?.close(1006);
    await h.flush(8);
    expect(h.store.getState().activeSessionId).toBe('vieja');
  });
});
